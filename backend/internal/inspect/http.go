package inspect

import (
	"container/list"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/arturborycki/aistore-ui/backend/internal/aistor"
	"github.com/arturborycki/aistore-ui/backend/internal/apierr"
	"github.com/arturborycki/aistore-ui/backend/internal/catalog"
	"github.com/arturborycki/aistore-ui/backend/internal/session"
)

// API serves GET /c/{cluster}/wh/{wh}/ns/{ns}/t/{table}/inspect.
type API struct {
	Deps    *catalog.Deps
	Limits  Limits
	Timeout time.Duration
	cache   *lru
}

func NewAPI(d *catalog.Deps) *API {
	return &API{Deps: d, Limits: DefaultLimits, Timeout: 90 * time.Second, cache: newLRU(64)}
}

func (a *API) Mount(r chi.Router) {
	r.Get("/wh/{wh}/ns/{ns}/t/{table}/inspect", a.handle)
}

var snapshotRe = regexp.MustCompile(`^-?\d{1,20}$`)

func (a *API) handle(w http.ResponseWriter, req *http.Request) {
	cluster := chi.URLParam(req, "cluster")
	client, ok := a.Deps.Clients[cluster]
	if !ok {
		apierr.Write(w, http.StatusNotFound, "NoSuchCluster", "unknown cluster")
		return
	}
	wh, _ := url.PathUnescape(chi.URLParam(req, "wh"))
	tbl, _ := url.PathUnescape(chi.URLParam(req, "table"))
	if catalog.ValidWarehouse(wh) != nil || catalog.ValidName("table", tbl) != nil {
		apierr.Write(w, http.StatusBadRequest, "ValidationError", "invalid warehouse or table")
		return
	}
	ns, err := catalog.ParseNamespace(chi.URLParam(req, "ns"))
	if err != nil {
		apierr.Write(w, http.StatusBadRequest, "ValidationError", err.Error())
		return
	}
	snap := req.URL.Query().Get("snapshot")
	if snap != "" && !snapshotRe.MatchString(snap) {
		apierr.Write(w, http.StatusBadRequest, "ValidationError", "invalid snapshot id")
		return
	}
	lim := a.Limits
	if v, err := strconv.Atoi(req.URL.Query().Get("files")); err == nil && v >= 0 && v <= 10000 {
		lim.MaxFiles = v
	}

	// Load the table with the caller's own credentials.
	up := &aistor.Request{Method: http.MethodGet, Segments: []string{wh, "namespaces", strings.Join(ns, "\x1f"), "tables", tbl}, RequestID: a.Deps.RequestID(req)}
	resp, err := a.Deps.Upstream(req, cluster, func(c *session.Credentials) (*http.Response, error) { return client.Do(req.Context(), c, up) })
	if err != nil {
		status, code, msg := catalog.ClassifyTransportErr(err)
		apierr.Write(w, status, code, msg)
		return
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(resp.StatusCode)
		_, _ = w.Write(body)
		return
	}

	var probe struct {
		Location string `json:"metadata-location"`
		Metadata struct {
			Current json.Number `json:"current-snapshot-id"`
		} `json:"metadata"`
	}
	_ = json.Unmarshal(body, &probe)
	if snap == "" {
		snap = probe.Metadata.Current.String()
	}

	fetch := func(ctx context.Context, bucket, key string) ([]byte, error) {
		r2 := req.WithContext(ctx)
		o, err := a.Deps.Upstream(r2, cluster, func(c *session.Credentials) (*http.Response, error) {
			return client.DoObject(ctx, c, &aistor.ObjectRequest{Method: http.MethodGet, Bucket: bucket, Key: key, RequestID: a.Deps.RequestID(req)})
		})
		if err != nil {
			return nil, err
		}
		defer o.Body.Close()
		if o.StatusCode != http.StatusOK {
			return nil, &objectError{status: o.StatusCode, bucket: bucket, key: key}
		}
		return io.ReadAll(io.LimitReader(o.Body, int64(a.Limits.MaxObjectBytes)+1))
	}

	cacheKey := fmt.Sprintf("%s|%s|%s|%s|%d", cluster, probe.Location, snap, tbl, lim.MaxFiles)
	if cached, ok := a.cache.get(cacheKey); ok {
		// The cached result is only served to callers who can read the
		// snapshot's manifest list themselves.
		if b, k, ok := SplitS3(cached.ManifestList); ok {
			if _, err := fetch(req.Context(), b, k); err == nil {
				writeJSON(w, cached)
				return
			} else {
				writeFetchErr(w, err)
				return
			}
		}
	}

	ctx, cancel := context.WithTimeout(req.Context(), a.Timeout)
	defer cancel()
	res, err := Inspect(ctx, body, snap, fetch, lim)
	if err != nil {
		switch {
		case errors.Is(err, ErrNoSnapshot):
			writeJSON(w, &Result{Manifests: []Manifest{}, Files: []File{}, Partitions: []Partition{}, Columns: []Column{}})
		case errors.Is(err, ErrOutsideTable):
			apierr.Write(w, http.StatusUnprocessableEntity, "OutsideTableLocation", err.Error())
		default:
			writeFetchErr(w, err)
		}
		return
	}
	if !res.Truncated {
		a.cache.put(cacheKey, res)
	}
	writeJSON(w, res)
}

type objectError struct {
	status      int
	bucket, key string
}

func (e *objectError) Error() string {
	return fmt.Sprintf("reading s3://%s/%s: HTTP %d", e.bucket, e.key, e.status)
}

func writeFetchErr(w http.ResponseWriter, err error) {
	var oe *objectError
	if errors.As(err, &oe) {
		if oe.status == http.StatusForbidden {
			w.Header().Set("X-Aistor-Action", "s3:GetObject")
			w.Header().Set("X-Aistor-Resource", "arn:aws:s3:::"+oe.bucket+"/*")
			apierr.Write(w, http.StatusForbidden, "AccessDenied", "reading table files needs s3:GetObject on the warehouse bucket "+oe.bucket)
			return
		}
		apierr.Write(w, http.StatusBadGateway, "ManifestUnavailable", oe.Error())
		return
	}
	if errors.Is(err, context.DeadlineExceeded) {
		apierr.Write(w, http.StatusGatewayTimeout, "InspectTimeout", "reading the table's manifests took too long")
		return
	}
	var se *aistor.STSError
	if errors.As(err, &se) || errors.Is(err, catalog.ErrCredentialsExpired) || errors.Is(err, catalog.ErrReauthenticate) {
		status, code, msg := catalog.ClassifyTransportErr(err)
		apierr.Write(w, status, code, msg)
		return
	}
	apierr.Write(w, http.StatusBadGateway, "ManifestUnreadable", err.Error())
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(v)
}

// ---------------------------------------------------------------- cache

type lru struct {
	mu  sync.Mutex
	cap int
	ll  *list.List
	m   map[string]*list.Element
}

type lruEntry struct {
	k string
	v *Result
}

func newLRU(n int) *lru { return &lru{cap: n, ll: list.New(), m: map[string]*list.Element{}} }

func (c *lru) get(k string) (*Result, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if e, ok := c.m[k]; ok {
		c.ll.MoveToFront(e)
		return e.Value.(*lruEntry).v, true
	}
	return nil, false
}

func (c *lru) put(k string, v *Result) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if e, ok := c.m[k]; ok {
		e.Value.(*lruEntry).v = v
		c.ll.MoveToFront(e)
		return
	}
	c.m[k] = c.ll.PushFront(&lruEntry{k, v})
	if c.ll.Len() > c.cap {
		last := c.ll.Back()
		c.ll.Remove(last)
		delete(c.m, last.Value.(*lruEntry).k)
	}
}
