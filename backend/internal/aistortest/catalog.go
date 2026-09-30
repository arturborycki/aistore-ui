package aistortest

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Catalog is an in-memory model of the AIStor Tables warehouse/namespace API,
// used by end-to-end tests. It implements listing (token and statistics
// modes), creation, deletion and namespace properties with AIStor semantics
// (e.g. only empty namespaces/warehouses can be deleted).
type Catalog struct {
	mu         sync.Mutex
	warehouses map[string]*whState
}

type whState struct {
	name       string
	uuid       string
	created    time.Time
	properties map[string]string
	namespaces map[string]*nsState // key: levels joined by 0x1F
	tags       map[string]string
	sse        string
	kmsKey     string
	maintCfg   map[string]any
}

func newWarehouse(name string, created time.Time, props map[string]string) *whState {
	if props == nil {
		props = map[string]string{}
	}
	tags := map[string]string{}
	for k, v := range props {
		tags[k] = v
	}
	return &whState{name: name, uuid: fakeUUID(name), created: created, properties: props, namespaces: map[string]*nsState{},
		tags: tags, sse: "AES256", maintCfg: map[string]any{
			"icebergUnreferencedFileRemoval": map[string]any{"status": "enabled", "settings": map[string]any{"icebergUnreferencedFileRemoval": map[string]any{"unreferencedDays": 3, "nonCurrentDays": 10}}},
		}}
}

type nsState struct {
	levels     []string
	properties map[string]string
	tables     int
	records    int64
	size       int64
	tbl        map[string]*tableState
	views      map[string]*viewState
}

func NewCatalog() *Catalog { return &Catalog{warehouses: map[string]*whState{}} }

// Seed adds a warehouse with namespaces; stats maps namespace path ("a.b") to {tables, records, size}.
func (c *Catalog) Seed(wh string, props map[string]string, namespaces map[string][3]int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	w := newWarehouse(wh, time.Now().Add(-time.Duration(len(wh)*37)*time.Hour), props)
	for path, st := range namespaces {
		levels := strings.Split(path, ".")
		for i := 1; i <= len(levels); i++ {
			k := strings.Join(levels[:i], "\x1f")
			if _, ok := w.namespaces[k]; !ok {
				w.namespaces[k] = &nsState{levels: levels[:i], properties: map[string]string{}}
			}
		}
		ns := w.namespaces[strings.Join(levels, "\x1f")]
		ns.populate(wh, int(st[0]), st[1], st[2])
		ns.properties["owner"] = levels[0] + "-team"
	}
	c.warehouses[wh] = w
}

func fakeUUID(s string) string {
	h := uint64(1469598103934665603)
	for _, b := range []byte(s) {
		h = (h ^ uint64(b)) * 1099511628211
	}
	return fmt.Sprintf("%08x-%04x-4%03x-a%03x-%012x", uint32(h), uint16(h>>32), uint16(h>>44)&0xfff, uint16(h>>20)&0xfff, h&0xffffffffffff)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func iceErr(w http.ResponseWriter, status int, typ, msg string) {
	writeJSON(w, status, map[string]any{"error": map[string]any{"message": msg, "type": typ, "code": status}})
}

type stats struct {
	Namespaces int   `json:"namespaces,omitempty"`
	Tables     int   `json:"tables"`
	Records    int64 `json:"records"`
	Size       int64 `json:"size"`
}

func (w *whState) stats() stats {
	s := stats{Namespaces: len(w.namespaces)}
	for _, ns := range w.namespaces {
		s.Tables += ns.tables
		s.Records += ns.records
		s.Size += ns.size
	}
	return s
}

func (w *whState) nsStats(prefix []string) stats {
	var s stats
	for _, ns := range w.namespaces {
		if hasPrefix(ns.levels, prefix) {
			s.Tables += ns.tables
			s.Records += ns.records
			s.Size += ns.size
		}
	}
	return s
}

func hasPrefix(levels, prefix []string) bool {
	if len(levels) < len(prefix) {
		return false
	}
	for i := range prefix {
		if levels[i] != prefix[i] {
			return false
		}
	}
	return true
}

type listReq struct {
	stats              bool
	search             string
	page, pageSize     int
	sortKey, sortOrder string
	pageToken          int
}

func parseList(q url.Values) listReq {
	lr := listReq{stats: q.Get("stats") == "true", search: strings.ToLower(q.Get("search")), pageSize: 100, sortKey: q.Get("sort"), sortOrder: q.Get("sort_order")}
	if lr.stats {
		lr.page, _ = strconv.Atoi(q.Get("page"))
		if v, err := strconv.Atoi(q.Get("page_size")); err == nil && v > 0 {
			lr.pageSize = min(v, 1000)
		}
	} else {
		if v, err := strconv.Atoi(q.Get("pageSize")); err == nil && v > 0 {
			lr.pageSize = v
		}
		lr.pageToken, _ = strconv.Atoi(q.Get("pageToken"))
	}
	return lr
}

// page applies search, sort and pagination to names with stats and writes list headers.
func (lr listReq) apply(w http.ResponseWriter, names []string, st func(string) stats) (out []string, next string) {
	filtered := names[:0:0]
	for _, n := range names {
		if lr.search == "" || strings.Contains(strings.ToLower(n), lr.search) {
			filtered = append(filtered, n)
		}
	}
	sort.SliceStable(filtered, func(i, j int) bool {
		a, b := filtered[i], filtered[j]
		var less bool
		switch lr.sortKey {
		case "size":
			less = st(a).Size < st(b).Size
		case "records":
			less = st(a).Records < st(b).Records
		case "tables":
			less = st(a).Tables < st(b).Tables
		case "namespaces":
			less = st(a).Namespaces < st(b).Namespaces
		default:
			less = a < b
		}
		if lr.sortOrder == "desc" {
			return !less && a != b
		}
		return less
	})
	start := lr.page * lr.pageSize
	if !lr.stats {
		start = lr.pageToken
	}
	if start > len(filtered) {
		start = len(filtered)
	}
	end := min(start+lr.pageSize, len(filtered))
	if lr.stats {
		w.Header().Set("X-Minio-Ui-Total-Count", strconv.Itoa(len(filtered)))
		w.Header().Set("X-Minio-Ui-List-Token", "node-1")
	} else if end < len(filtered) {
		next = strconv.Itoa(end)
	}
	return filtered[start:end], next
}

// Handle serves an authorised catalog request (path relative to /_iceberg/v1).
func (c *Catalog) Handle(w http.ResponseWriter, r *http.Request) {
	c.mu.Lock()
	defer c.mu.Unlock()
	raw := strings.TrimPrefix(r.URL.EscapedPath(), "/_iceberg/v1/")
	var segs []string
	for _, s := range strings.Split(raw, "/") {
		d, _ := url.PathUnescape(s)
		segs = append(segs, d)
	}
	q := r.URL.Query()
	switch {
	case len(segs) == 1 && segs[0] == "stats" && r.Method == "GET":
		var total stats
		for _, wh := range c.warehouses {
			s := wh.stats()
			total.Namespaces += s.Namespaces
			total.Tables += s.Tables
			total.Records += s.Records
			total.Size += s.Size
		}
		writeJSON(w, 200, map[string]any{"warehouses": len(c.warehouses), "namespaces": total.Namespaces, "tables": total.Tables, "records": total.Records, "size": total.Size})
	case len(segs) == 1 && segs[0] == "config":
		writeJSON(w, 200, map[string]any{"defaults": map[string]string{"s3.delete-enabled": "false"}, "overrides": map[string]string{"prefix": q.Get("warehouse")}})
	case len(segs) == 1 && segs[0] == "warehouses" && r.Method == "GET":
		names := make([]string, 0, len(c.warehouses))
		for n := range c.warehouses {
			names = append(names, n)
		}
		lr := parseList(q)
		st := func(n string) stats { return c.warehouses[n].stats() }
		page, next := lr.apply(w, names, st)
		resp := map[string]any{"warehouses": page}
		if next != "" {
			resp["next-page-token"] = next
		}
		if lr.stats {
			m := map[string]stats{}
			for _, n := range page {
				m[n] = st(n)
			}
			resp["stats"] = m
		}
		writeJSON(w, 200, resp)
	case len(segs) == 1 && segs[0] == "warehouses" && r.Method == "POST":
		var body struct {
			Name string `json:"name"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if _, ok := c.warehouses[body.Name]; ok {
			iceErr(w, 409, "AlreadyExistsException", "warehouse already exists: "+body.Name)
			return
		}
		c.warehouses[body.Name] = newWarehouse(body.Name, time.Now(), nil)
		writeJSON(w, 200, map[string]any{"name": body.Name})
	case len(segs) == 2 && segs[0] == "warehouses":
		wh, ok := c.warehouses[segs[1]]
		if !ok {
			iceErr(w, 404, "NoSuchWarehouseException", "warehouse does not exist: "+segs[1])
			return
		}
		if r.Method == "DELETE" {
			if len(wh.namespaces) > 0 {
				iceErr(w, 409, "WarehouseNotEmptyException", "warehouse is not empty: "+segs[1])
				return
			}
			delete(c.warehouses, segs[1])
			w.WriteHeader(204)
			return
		}
		writeJSON(w, 200, map[string]any{"name": wh.name, "bucket": wh.name, "uuid": wh.uuid, "created-at": wh.created.UTC().Format(time.RFC3339), "properties": wh.properties})
	case len(segs) == 3 && (segs[0] == "warehouses" || segs[0] == "buckets") && (segs[2] == "encryption" || segs[2] == "tags"):
		wh, ok := c.warehouses[segs[1]]
		if !ok {
			iceErr(w, 404, "NoSuchWarehouseException", "warehouse does not exist: "+segs[1])
			return
		}
		c.warehouseSettings(w, r, wh, segs[2], q)
	case len(segs) >= 2 && segs[1] == "maintenance" && c.warehouses[segs[0]] != nil:
		c.warehouseSettings(w, r, c.warehouses[segs[0]], strings.Join(segs[1:], "/"), q)
	case len(segs) == 3 && segs[1] == "transactions" && segs[2] == "commit" && r.Method == "POST" && c.warehouses[segs[0]] != nil:
		c.transaction(w, r, c.warehouses[segs[0]])
	case len(segs) == 3 && (segs[1] == "tables" || segs[1] == "views") && segs[2] == "rename" && r.Method == "POST":
		wh, ok := c.warehouses[segs[0]]
		if !ok {
			iceErr(w, 404, "NoSuchWarehouseException", "warehouse does not exist: "+segs[0])
			return
		}
		c.rename(w, r, wh, strings.TrimSuffix(segs[1], "s"))
	case len(segs) >= 2 && segs[1] == "namespaces":
		wh, ok := c.warehouses[segs[0]]
		if !ok {
			iceErr(w, 404, "NoSuchWarehouseException", "warehouse does not exist: "+segs[0])
			return
		}
		c.handleNamespaces(w, r, wh, segs[2:], q)
	default:
		iceErr(w, 404, "NotFound", "no such route in test catalog")
	}
}

func (c *Catalog) handleNamespaces(w http.ResponseWriter, r *http.Request, wh *whState, rest []string, q url.Values) {
	if len(rest) == 0 {
		switch r.Method {
		case "GET":
			var parent []string
			if p := q.Get("parent"); p != "" {
				parent = strings.Split(p, "\x1f")
			}
			var names []string
			byName := map[string][]string{}
			for _, ns := range wh.namespaces {
				if len(ns.levels) == len(parent)+1 && hasPrefix(ns.levels, parent) {
					n := strings.Join(ns.levels, ".")
					names = append(names, n)
					byName[n] = ns.levels
				}
			}
			lr := parseList(q)
			st := func(n string) stats { return wh.nsStats(byName[n]) }
			page, next := lr.apply(w, names, st)
			out := make([][]string, 0, len(page))
			m := map[string]stats{}
			for _, n := range page {
				out = append(out, byName[n])
				m[n] = st(n)
			}
			resp := map[string]any{"namespaces": out}
			if next != "" {
				resp["next-page-token"] = next
			}
			if lr.stats {
				resp["stats"] = m
			}
			writeJSON(w, 200, resp)
		case "POST":
			var body struct {
				Namespace  []string          `json:"namespace"`
				Properties map[string]string `json:"properties"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			k := strings.Join(body.Namespace, "\x1f")
			if _, ok := wh.namespaces[k]; ok {
				iceErr(w, 409, "AlreadyExistsException", "namespace already exists: "+strings.Join(body.Namespace, "."))
				return
			}
			if len(body.Namespace) > 1 {
				if _, ok := wh.namespaces[strings.Join(body.Namespace[:len(body.Namespace)-1], "\x1f")]; !ok {
					iceErr(w, 404, "NoSuchNamespaceException", "parent namespace does not exist")
					return
				}
			}
			if body.Properties == nil {
				body.Properties = map[string]string{}
			}
			wh.namespaces[k] = &nsState{levels: body.Namespace, properties: body.Properties}
			writeJSON(w, 200, map[string]any{"namespace": body.Namespace, "properties": body.Properties})
		}
		return
	}
	ns, ok := wh.namespaces[rest[0]]
	if !ok {
		iceErr(w, 404, "NoSuchNamespaceException", "namespace does not exist: "+strings.ReplaceAll(rest[0], "\x1f", "."))
		return
	}
	switch {
	case len(rest) == 1 && r.Method == "GET":
		writeJSON(w, 200, map[string]any{"namespace": ns.levels, "properties": ns.properties})
	case len(rest) == 1 && r.Method == "DELETE":
		for k, other := range wh.namespaces {
			if k != rest[0] && hasPrefix(other.levels, ns.levels) {
				iceErr(w, 409, "NamespaceNotEmptyException", "namespace is not empty: "+strings.Join(ns.levels, "."))
				return
			}
		}
		if ns.tables > 0 || len(ns.views) > 0 {
			iceErr(w, 409, "NamespaceNotEmptyException", "namespace is not empty: "+strings.Join(ns.levels, "."))
			return
		}
		delete(wh.namespaces, rest[0])
		w.WriteHeader(204)
	case len(rest) == 2 && rest[1] == "properties" && r.Method == "POST":
		var body struct {
			Updates  map[string]string `json:"updates"`
			Removals []string          `json:"removals"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		updated, removed, missing := []string{}, []string{}, []string{}
		for k, v := range body.Updates {
			ns.properties[k] = v
			updated = append(updated, k)
		}
		for _, k := range body.Removals {
			if _, ok := ns.properties[k]; ok {
				delete(ns.properties, k)
				removed = append(removed, k)
			} else {
				missing = append(missing, k)
			}
		}
		writeJSON(w, 200, map[string]any{"updated": updated, "removed": removed, "missing": missing})
	case len(rest) >= 2 && rest[1] == "tables":
		c.handleTables(w, r, wh, ns, rest[2:], q)
	case len(rest) >= 2 && rest[1] == "views":
		c.handleViews(w, r, wh, ns, rest[2:])
	case len(rest) == 2 && rest[1] == "register" && r.Method == "POST":
		c.register(w, r, wh, ns, "table")
	case len(rest) == 2 && rest[1] == "register-view" && r.Method == "POST":
		c.register(w, r, wh, ns, "view")
	default:
		iceErr(w, 404, "NotFound", "no such route in test catalog")
	}
}
