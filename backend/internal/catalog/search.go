package catalog

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode"

	"github.com/go-chi/chi/v5"

	"github.com/arturborycki/aistore-ui/backend/internal/aistor"
	"github.com/arturborycki/aistore-ui/backend/internal/apierr"
)

// Catalog-wide search. AIStor has no global search API, so the server walks
// warehouses → namespaces → tables/views with the caller's own credentials
// (results therefore only contain what the caller may list), using AIStor's
// server-side name filter where it exists. The walk is bounded by a request
// budget, a concurrency limit and a deadline; the response says when it was cut short.

type SearchHit struct {
	Kind      string   `json:"kind"` // warehouse | namespace | table | view
	Warehouse string   `json:"warehouse"`
	Namespace []string `json:"namespace,omitempty"`
	Name      string   `json:"name"`
	rank      int
}

type SearchResult struct {
	Hits      []SearchHit `json:"results"`
	Truncated bool        `json:"truncated"`
	Requests  int64       `json:"requests"`
	Skipped   int64       `json:"skipped"` // subtrees the caller may not list
}

type SearchLimits struct {
	MaxRequests int64
	Concurrency int
	Timeout     time.Duration
	MaxResults  int
}

var DefaultSearchLimits = SearchLimits{MaxRequests: 300, Concurrency: 8, Timeout: 8 * time.Second, MaxResults: 50}

// fetcher performs a signed GET and returns the status and body.
type fetcher func(ctx context.Context, r *Request) (int, []byte, error)

// Request is a minimal description of an upstream GET used by the search walker.
type Request struct {
	Segments []string
	Query    url.Values
}

func rankOf(name, q string) int {
	n := strings.ToLower(name)
	switch {
	case n == q:
		return 0
	case strings.HasPrefix(n, q):
		return 1
	default:
		return 2
	}
}

type searcher struct {
	q        string
	lim      SearchLimits
	fetch    fetcher
	requests atomic.Int64
	skipped  atomic.Int64
	mu       sync.Mutex
	hits     []SearchHit
	full     atomic.Bool
	cut      atomic.Bool
	sem      chan struct{}
	wg       sync.WaitGroup
}

func (s *searcher) add(h SearchHit) {
	s.mu.Lock()
	defer s.mu.Unlock()
	h.rank = rankOf(h.Name, s.q)
	s.hits = append(s.hits, h)
	if len(s.hits) >= s.lim.MaxResults*4 { // collect a margin, then rank and trim
		s.full.Store(true)
	}
}

// get fetches one page, respecting the budget. ok=false means "skip this subtree".
func (s *searcher) get(ctx context.Context, segs []string, q url.Values, out any) bool {
	if s.full.Load() || ctx.Err() != nil {
		s.cut.Store(true)
		return false
	}
	if s.requests.Add(1) > s.lim.MaxRequests {
		s.cut.Store(true)
		return false
	}
	status, body, err := s.fetch(ctx, &Request{Segments: segs, Query: q})
	if err != nil {
		if ctx.Err() != nil {
			s.cut.Store(true)
		}
		return false
	}
	if status != http.StatusOK {
		s.skipped.Add(1)
		return false
	}
	return json.Unmarshal(body, out) == nil
}

func (s *searcher) spawn(ctx context.Context, f func()) {
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		select {
		case s.sem <- struct{}{}:
		case <-ctx.Done():
			s.cut.Store(true)
			return
		}
		defer func() { <-s.sem }()
		f()
	}()
}

func (s *searcher) namespaces(ctx context.Context, wh string, parent []string) {
	q := url.Values{"pageSize": {"1000"}}
	if len(parent) > 0 {
		q.Set("parent", strings.Join(parent, "\x1f"))
	}
	var resp struct {
		Namespaces [][]string `json:"namespaces"`
	}
	if !s.get(ctx, []string{wh, "namespaces"}, q, &resp) {
		return
	}
	for _, ns := range resp.Namespaces {
		ns := ns
		if len(ns) == 0 {
			continue
		}
		if strings.Contains(strings.ToLower(ns[len(ns)-1]), s.q) {
			s.add(SearchHit{Kind: "namespace", Warehouse: wh, Namespace: ns[:len(ns)-1], Name: ns[len(ns)-1]})
		}
		s.spawn(ctx, func() { s.tables(ctx, wh, ns) })
		s.spawn(ctx, func() { s.views(ctx, wh, ns) })
		if len(ns) < 10 {
			s.spawn(ctx, func() { s.namespaces(ctx, wh, ns) })
		}
	}
}

type idList struct {
	Identifiers []struct {
		Namespace []string `json:"namespace"`
		Name      string   `json:"name"`
	} `json:"identifiers"`
}

func (s *searcher) tables(ctx context.Context, wh string, ns []string) {
	var resp idList
	// AIStor filters table names server-side (case-insensitive substring).
	if !s.get(ctx, []string{wh, "namespaces", strings.Join(ns, "\x1f"), "tables"}, url.Values{"search": {s.q}, "pageSize": {"200"}}, &resp) {
		return
	}
	for _, id := range resp.Identifiers {
		if strings.Contains(strings.ToLower(id.Name), s.q) {
			s.add(SearchHit{Kind: "table", Warehouse: wh, Namespace: ns, Name: id.Name})
		}
	}
}

func (s *searcher) views(ctx context.Context, wh string, ns []string) {
	var resp idList
	if !s.get(ctx, []string{wh, "namespaces", strings.Join(ns, "\x1f"), "views"}, url.Values{"pageSize": {"1000"}}, &resp) {
		return
	}
	for _, id := range resp.Identifiers {
		if strings.Contains(strings.ToLower(id.Name), s.q) {
			s.add(SearchHit{Kind: "view", Warehouse: wh, Namespace: ns, Name: id.Name})
		}
	}
}

// Search walks the catalog for names containing q.
func Search(ctx context.Context, fetch fetcher, q string, lim SearchLimits) (*SearchResult, error) {
	q = strings.ToLower(strings.TrimSpace(q))
	ctx, cancel := context.WithTimeout(ctx, lim.Timeout)
	defer cancel()
	s := &searcher{q: q, lim: lim, fetch: fetch, sem: make(chan struct{}, lim.Concurrency)}

	var whs []string
	token := ""
	for page := 0; page < 5; page++ {
		qv := url.Values{"pageSize": {"1000"}}
		if token != "" {
			qv.Set("pageToken", token)
		}
		var resp struct {
			Warehouses []string `json:"warehouses"`
			Next       string   `json:"next-page-token"`
		}
		if !s.get(ctx, []string{"warehouses"}, qv, &resp) {
			if page == 0 && s.skipped.Load() > 0 {
				return nil, errors.New("the warehouse list is not accessible")
			}
			break
		}
		whs = append(whs, resp.Warehouses...)
		if token = resp.Next; token == "" {
			break
		}
	}
	for _, wh := range whs {
		wh := wh
		if strings.Contains(strings.ToLower(wh), q) {
			s.add(SearchHit{Kind: "warehouse", Warehouse: wh, Name: wh})
		}
		s.spawn(ctx, func() { s.namespaces(ctx, wh, nil) })
	}
	s.wg.Wait()

	order := map[string]int{"warehouse": 0, "namespace": 1, "table": 2, "view": 3}
	sort.SliceStable(s.hits, func(i, j int) bool {
		a, b := s.hits[i], s.hits[j]
		if a.rank != b.rank {
			return a.rank < b.rank
		}
		if order[a.Kind] != order[b.Kind] {
			return order[a.Kind] < order[b.Kind]
		}
		return a.Warehouse+"."+strings.Join(a.Namespace, ".")+"."+a.Name < b.Warehouse+"."+strings.Join(b.Namespace, ".")+"."+b.Name
	})
	res := &SearchResult{Hits: s.hits, Requests: min(s.requests.Load(), lim.MaxRequests), Skipped: s.skipped.Load(), Truncated: s.cut.Load()}
	if len(res.Hits) > lim.MaxResults {
		res.Hits = res.Hits[:lim.MaxResults]
		res.Truncated = true
	}
	if res.Hits == nil {
		res.Hits = []SearchHit{}
	}
	return res, nil
}

func validQuery(q string) bool {
	if q == "" || len(q) > 100 {
		return false
	}
	for _, r := range q {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}

// mountSearch registers GET /c/{cluster}/search?q=&limit=.
func mountSearch(r chi.Router, d *Deps) {
	r.Get("/search", func(w http.ResponseWriter, req *http.Request) {
		cluster := chi.URLParam(req, "cluster")
		client, ok := d.Clients[cluster]
		if !ok {
			apierr.Write(w, http.StatusNotFound, "NoSuchCluster", "unknown cluster")
			return
		}
		q := strings.TrimSpace(req.URL.Query().Get("q"))
		if !validQuery(q) || len([]rune(q)) < 2 {
			apierr.Write(w, http.StatusBadRequest, "ValidationError", "q must be 2-100 characters")
			return
		}
		lim := DefaultSearchLimits
		if v, err := strconv.Atoi(req.URL.Query().Get("limit")); err == nil && v > 0 && v <= 100 {
			lim.MaxResults = v
		}
		fetch := func(ctx context.Context, r *Request) (int, []byte, error) {
			up := &aistor.Request{Method: http.MethodGet, Segments: r.Segments, Query: r.Query, RequestID: d.RequestID(req)}
			resp, err := doWithRefresh(req.WithContext(ctx), client, cluster, up, d)
			if err != nil {
				return 0, nil, err
			}
			defer resp.Body.Close()
			body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
			return resp.StatusCode, body, err
		}
		res, err := Search(req.Context(), fetch, q, lim)
		if err != nil {
			apierr.Write(w, http.StatusForbidden, "AccessDenied", err.Error())
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(res)
	})
}
