package semantic

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/arturborycki/aistore-ui/backend/internal/aistor"
	"github.com/arturborycki/aistore-ui/backend/internal/session"
)

// resolver loads Iceberg tables with the caller's credentials, caching per
// request, and finds datasets' tables (by UUID when they were renamed).
type resolver struct {
	a       *API
	req     *http.Request
	cluster string
	client  *aistor.Client
	cache   map[string]*TableInfo
	status  map[string]int
	budget  int // remaining upstream calls for UUID searches
}

func (a *API) newResolver(req *http.Request, cluster string, client *aistor.Client) *resolver {
	return &resolver{a: a, req: req, cluster: cluster, client: client, cache: map[string]*TableInfo{}, status: map[string]int{}, budget: 300}
}

func (r *resolver) get(segments []string, q url.Values) (int, []byte, error) {
	up := &aistor.Request{Method: http.MethodGet, Segments: segments, Query: q, RequestID: r.a.Deps.RequestID(r.req)}
	resp, err := r.a.Deps.Upstream(r.req, r.cluster, func(c *session.Credentials) (*http.Response, error) {
		return r.client.Do(r.req.Context(), c, up)
	})
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	return resp.StatusCode, body, err
}

// table loads warehouse.ns.name; status is the upstream HTTP status.
func (r *resolver) table(wh string, ns []string, name string) (*TableInfo, int, error) {
	k := wh + "\x00" + strings.Join(ns, "\x1f") + "\x00" + name
	if t, ok := r.cache[k]; ok {
		return t, r.status[k], nil
	}
	st, body, err := r.get([]string{wh, "namespaces", strings.Join(ns, "\x1f"), "tables", name}, nil)
	if err != nil {
		return nil, 0, err
	}
	var t *TableInfo
	if st == http.StatusOK {
		if t, err = ParseTable(wh, ns, name, body); err != nil {
			return nil, st, err
		}
	}
	r.cache[k], r.status[k] = t, st
	return t, st, nil
}

// findByUUID walks a warehouse (the preferred namespace first) looking for a
// table with the given UUID, within the request budget.
func (r *resolver) findByUUID(wh string, prefer []string, uuid string) *TableInfo {
	check := func(ns []string) *TableInfo {
		if r.budget <= 0 {
			return nil
		}
		r.budget--
		st, body, err := r.get([]string{wh, "namespaces", strings.Join(ns, "\x1f"), "tables"}, url.Values{"pageSize": {"1000"}})
		if err != nil || st != http.StatusOK {
			return nil
		}
		var ids struct {
			Identifiers []struct {
				Name string `json:"name"`
			} `json:"identifiers"`
		}
		_ = json.Unmarshal(body, &ids)
		for _, id := range ids.Identifiers {
			if r.budget <= 0 {
				return nil
			}
			r.budget--
			if t, _, _ := r.table(wh, ns, id.Name); t != nil && t.UUID == uuid {
				return t
			}
		}
		return nil
	}
	if len(prefer) > 0 {
		if t := check(prefer); t != nil {
			return t
		}
	}
	queue := [][]string{nil}
	for len(queue) > 0 && r.budget > 0 {
		parent := queue[0]
		queue = queue[1:]
		q := url.Values{"pageSize": {"1000"}}
		if len(parent) > 0 {
			q.Set("parent", strings.Join(parent, "\x1f"))
		}
		r.budget--
		st, body, err := r.get([]string{wh, "namespaces"}, q)
		if err != nil || st != http.StatusOK {
			continue
		}
		var nss struct {
			Namespaces [][]string `json:"namespaces"`
		}
		_ = json.Unmarshal(body, &nss)
		for _, ns := range nss.Namespaces {
			if strings.Join(ns, "\x1f") != strings.Join(prefer, "\x1f") {
				if t := check(ns); t != nil {
					return t
				}
			}
			if len(ns) < 10 {
				queue = append(queue, ns)
			}
		}
	}
	return nil
}

func (r *resolver) sourceTable(source string) (wh string, ns []string, name string, ok bool) {
	parts, ok := ParseSource(source)
	if !ok {
		return "", nil, "", false
	}
	wh = parts[0]
	for w, alias := range r.a.Cfg.CatalogAliases {
		if alias == parts[0] {
			wh = w
		}
	}
	return wh, parts[1 : len(parts)-1], parts[len(parts)-1], true
}

// resolve maps a dataset to its table.
func (r *resolver) resolve(d *Dataset) Resolution {
	if x, ok := d.Ext(); ok {
		t, st, err := r.table(x.Warehouse, x.Namespace, x.Table)
		if err != nil {
			return Resolution{Reason: "the catalog could not be reached"}
		}
		if t != nil && t.UUID == x.TableUUID {
			return Resolution{Table: t, Tracked: true}
		}
		if st == http.StatusForbidden {
			return Resolution{Reason: fmt.Sprintf("you may not read %s.%s.%s", x.Warehouse, strings.Join(x.Namespace, "."), x.Table)}
		}
		if moved := r.findByUUID(x.Warehouse, x.Namespace, x.TableUUID); moved != nil {
			return Resolution{Table: moved, Tracked: true, Moved: true}
		}
		if r.budget <= 0 {
			return Resolution{Reason: "the table was not found within the search budget"}
		}
		return Resolution{Tracked: true, Reason: fmt.Sprintf("%s.%s.%s was dropped", x.Warehouse, strings.Join(x.Namespace, "."), x.Table)}
	}
	wh, ns, name, ok := r.sourceTable(d.Source)
	if !ok {
		return Resolution{Reason: "source is not a catalog table (catalog.namespace.table)"}
	}
	t, st, err := r.table(wh, ns, name)
	switch {
	case err != nil:
		return Resolution{Reason: "the catalog could not be reached"}
	case t != nil:
		return Resolution{Table: t}
	case st == http.StatusForbidden:
		return Resolution{Reason: "you may not read " + d.Source}
	case st == http.StatusNotFound:
		return Resolution{Reason: fmt.Sprintf("table %s was not found", d.Source)}
	}
	return Resolution{Reason: fmt.Sprintf("table %s could not be loaded (HTTP %d)", d.Source, st)}
}

func (r *resolver) resolveAll(m *Model) []Resolution {
	out := make([]Resolution, len(m.Datasets))
	for i := range m.Datasets {
		out[i] = r.resolve(&m.Datasets[i])
	}
	return out
}

// catalogProblems runs the catalog checks for m.
func (r *resolver) catalogProblems(m *Model, res []Resolution) []Problem {
	tables := make([]*TableInfo, len(res))
	reasons := make([]string, len(res))
	for i, x := range res {
		tables[i] = x.Table
		reasons[i] = x.Reason
	}
	return CatalogProblems(m, tables, reasons)
}
