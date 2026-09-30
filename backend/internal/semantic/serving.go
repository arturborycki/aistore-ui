package semantic

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/arturborycki/aistore-ui/backend/internal/apierr"
	"github.com/arturborycki/aistore-ui/backend/internal/catalog"
)

// Serving exposes models read-only to tools and agents: a REST API under
// /ossie/v1 and an MCP server at /ossie/mcp. Authentication (bearer tokens)
// is applied by the caller; every read uses the caller's own credentials.

// ModelURL is the REST path of a model.
func ModelURL(cluster, wh string, ns []string, model string) string {
	return fmt.Sprintf("/ossie/v1/models/%s/%s/%s/%s", url.PathEscape(cluster), url.PathEscape(wh), url.PathEscape(strings.Join(ns, "\x1f")), url.PathEscape(model))
}

// MountServing registers the REST routes (relative to /ossie).
func (a *API) MountServing(r chi.Router) {
	r.Get("/v1/models", a.handleIndex)
	r.Get("/v1/models/{cluster}/{wh}/{ns}/{model}", a.handleServeModel)
	r.Get("/v1/search", a.handleServeSearch)
}

// ServeSchema returns the embedded Ossie JSON Schema (public).
func ServeSchema(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/schema+json")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	_, _ = w.Write(schemaJSON)
}

// IndexEntry is one model in the index.
type IndexEntry struct {
	ID          string   `json:"id"`
	Cluster     string   `json:"cluster"`
	Warehouse   string   `json:"warehouse"`
	Namespace   []string `json:"namespace"`
	Name        string   `json:"name"`
	Description string   `json:"description,omitempty"`
	Datasets    []string `json:"datasets"`
	Metrics     []string `json:"metrics,omitempty"`
	URL         string   `json:"url"`
}

func (a *API) clusters() []string {
	out := make([]string, 0, len(a.Deps.Clients))
	for c := range a.Deps.Clients {
		out = append(out, c)
	}
	sort.Strings(out)
	return out
}

// index lists every model the caller may read, optionally on one cluster.
func (a *API) index(req *http.Request, only string) ([]IndexEntry, bool) {
	var out []IndexEntry
	truncated := false
	for _, c := range a.clusters() {
		if only != "" && c != only {
			continue
		}
		models, tr := a.ScanCluster(withCluster(req, c), c, a.Deps.Clients[c])
		truncated = truncated || tr
		for _, s := range models {
			e := IndexEntry{ID: fmt.Sprintf("%s/%s/%s/%s", c, s.WH, strings.Join(s.NS, "."), s.Name), Cluster: c, Warehouse: s.WH, Namespace: s.NS, Name: s.Name, Description: s.Model.Description, URL: ModelURL(c, s.WH, s.NS, s.Name)}
			for _, d := range s.Model.Datasets {
				e.Datasets = append(e.Datasets, d.Name)
			}
			for _, m := range s.Model.Metrics {
				e.Metrics = append(e.Metrics, m.Name)
			}
			out = append(out, e)
		}
	}
	return out, truncated
}

// withCluster sets the chi "cluster" URL parameter for handlers reused outside their route.
func withCluster(req *http.Request, cluster string) *http.Request {
	rc := chi.NewRouteContext()
	if cur := chi.RouteContext(req.Context()); cur != nil {
		for i, k := range cur.URLParams.Keys {
			if k != "cluster" {
				rc.URLParams.Add(k, cur.URLParams.Values[i])
			}
		}
	}
	rc.URLParams.Add("cluster", cluster)
	return req.WithContext(contextWithRoute(req, rc))
}

func (a *API) handleIndex(w http.ResponseWriter, req *http.Request) {
	entries, truncated := a.index(req, req.URL.Query().Get("cluster"))
	if entries == nil {
		entries = []IndexEntry{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"specVersion": SpecVersion, "models": entries, "truncated": truncated})
}

func (a *API) handleServeModel(w http.ResponseWriter, req *http.Request) {
	t, err := a.target(req)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	obj, err := a.Store.Get(req, t.cluster, t.client, t.key(), req.URL.Query().Get("version"), a.Cfg.MaxModelBytes)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	etag := `"` + obj.ETag + `"`
	w.Header().Set("ETag", etag)
	w.Header().Set("Cache-Control", "private, no-cache")
	if inm := req.Header.Get("If-None-Match"); inm != "" && (inm == etag || inm == obj.ETag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	wantJSON := req.URL.Query().Get("format") == "json" || (req.URL.Query().Get("format") == "" && strings.Contains(req.Header.Get("Accept"), "application/json"))
	if !wantJSON {
		w.Header().Set("Content-Type", "application/yaml; charset=utf-8")
		_, _ = w.Write(obj.Body)
		return
	}
	m, ps, err := Parse(obj.Body, a.limits())
	if err != nil || len(ps) > 0 {
		apierr.Write(w, http.StatusUnprocessableEntity, "InvalidModel", "the stored document is not a valid Ossie model")
		return
	}
	b, _ := MarshalJSON(m)
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(b)
}

func (a *API) search(req *http.Request, q, only string) ([]SearchHit, bool) {
	var hits []SearchHit
	truncated := false
	for _, c := range a.clusters() {
		if only != "" && c != only {
			continue
		}
		models, tr := a.ScanCluster(withCluster(req, c), c, a.Deps.Clients[c])
		truncated = truncated || tr
		for _, h := range SearchModels(models, q, 50) {
			h.Cluster = c
			hits = append(hits, h)
		}
	}
	if len(hits) > 50 {
		hits = hits[:50]
	}
	return hits, truncated
}

func (a *API) handleServeSearch(w http.ResponseWriter, req *http.Request) {
	q := strings.TrimSpace(req.URL.Query().Get("q"))
	if len([]rune(q)) < 2 || len(q) > 100 {
		a.writeErr(w, badRequest("q must be 2-100 characters"))
		return
	}
	hits, truncated := a.search(req, q, req.URL.Query().Get("cluster"))
	if hits == nil {
		hits = []SearchHit{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"results": hits, "truncated": truncated})
}

// ---------------------------------------------------------------- MCP

// MCPProtocolVersions are the MCP revisions this server speaks (newest first).
var MCPProtocolVersions = []string{"2025-06-18", "2025-03-26", "2024-11-05"}

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func rpcReply(w http.ResponseWriter, id json.RawMessage, result any, e *rpcError) {
	resp := map[string]any{"jsonrpc": "2.0", "id": id}
	if e != nil {
		resp["error"] = e
	} else {
		resp["result"] = result
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(resp)
}

var mcpTools = []map[string]any{
	{
		"name":        "list_models",
		"title":       "List semantic models",
		"description": "Lists the Apache Ossie semantic models you may read in the AIStor catalog, with their datasets and metrics. Start here to find the model that answers a question.",
		"inputSchema": map[string]any{"type": "object", "properties": map[string]any{
			"cluster": map[string]any{"type": "string", "description": "Only this cluster (optional)."},
		}},
		"annotations": map[string]any{"readOnlyHint": true, "openWorldHint": false},
	},
	{
		"name":        "get_model",
		"title":       "Get a semantic model",
		"description": "Returns one Apache Ossie semantic model: datasets (tables), fields with business descriptions and synonyms, keys, relationships (joins) and metric definitions (SQL), plus instructions for AI agents.",
		"inputSchema": map[string]any{"type": "object", "required": []string{"cluster", "warehouse", "namespace", "model"}, "properties": map[string]any{
			"cluster":   map[string]any{"type": "string"},
			"warehouse": map[string]any{"type": "string"},
			"namespace": map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "Namespace levels, e.g. [\"sales\"]."},
			"model":     map[string]any{"type": "string"},
			"format":    map[string]any{"type": "string", "enum": []string{"yaml", "json"}, "default": "yaml"},
		}},
		"annotations": map[string]any{"readOnlyHint": true, "openWorldHint": false},
	},
	{
		"name":        "search_semantics",
		"title":       "Search semantic models",
		"description": "Finds models, datasets, fields, metrics and relationships whose names, synonyms or descriptions match a business term (e.g. \"revenue\", \"customer\").",
		"inputSchema": map[string]any{"type": "object", "required": []string{"query"}, "properties": map[string]any{
			"query":   map[string]any{"type": "string", "minLength": 2, "maxLength": 100},
			"cluster": map[string]any{"type": "string"},
		}},
		"annotations": map[string]any{"readOnlyHint": true, "openWorldHint": false},
	},
}

// HandleMCP serves the Model Context Protocol (Streamable HTTP transport,
// JSON responses, stateless). Tools are read-only.
func (a *API) HandleMCP(serverVersion string) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		if req.Method != http.MethodPost {
			w.Header().Set("Allow", "POST")
			apierr.Write(w, http.StatusMethodNotAllowed, "MethodNotAllowed", "this MCP endpoint only accepts POST (no server-sent event stream)")
			return
		}
		raw, err := io.ReadAll(io.LimitReader(req.Body, 1<<20))
		if err != nil {
			rpcReply(w, nil, nil, &rpcError{Code: -32700, Message: "parse error"})
			return
		}
		if t := strings.TrimSpace(string(raw)); strings.HasPrefix(t, "[") {
			rpcReply(w, nil, nil, &rpcError{Code: -32600, Message: "batches are not supported"})
			return
		}
		var r rpcRequest
		if err := json.Unmarshal(raw, &r); err != nil || r.JSONRPC != "2.0" || r.Method == "" {
			rpcReply(w, nil, nil, &rpcError{Code: -32600, Message: "invalid JSON-RPC request"})
			return
		}
		if len(r.ID) == 0 { // a notification (e.g. notifications/initialized)
			w.WriteHeader(http.StatusAccepted)
			return
		}
		switch r.Method {
		case "initialize":
			var p struct {
				ProtocolVersion string `json:"protocolVersion"`
			}
			_ = json.Unmarshal(r.Params, &p)
			version := MCPProtocolVersions[0]
			for _, v := range MCPProtocolVersions {
				if v == p.ProtocolVersion {
					version = v
				}
			}
			rpcReply(w, r.ID, map[string]any{
				"protocolVersion": version,
				"capabilities":    map[string]any{"tools": map[string]any{"listChanged": false}},
				"serverInfo":      map[string]any{"name": "aistor-catalog-ossie", "title": "AIStor Catalog semantic models", "version": serverVersion},
				"instructions":    "Semantic models describe AIStor (Apache Iceberg) tables in business terms. Use search_semantics or list_models to find a model, then get_model for datasets, joins and metric SQL. Access follows your own AIStor permissions.",
			}, nil)
		case "ping":
			rpcReply(w, r.ID, map[string]any{}, nil)
		case "tools/list":
			rpcReply(w, r.ID, map[string]any{"tools": mcpTools}, nil)
		case "tools/call":
			var p struct {
				Name      string          `json:"name"`
				Arguments json.RawMessage `json:"arguments"`
			}
			if err := json.Unmarshal(r.Params, &p); err != nil {
				rpcReply(w, r.ID, nil, &rpcError{Code: -32602, Message: "invalid params"})
				return
			}
			text, structured, toolErr, rpcErr := a.callTool(req, p.Name, p.Arguments)
			if rpcErr != nil {
				rpcReply(w, r.ID, nil, rpcErr)
				return
			}
			res := map[string]any{"content": []map[string]any{{"type": "text", "text": text}}, "isError": toolErr}
			if structured != nil {
				res["structuredContent"] = structured
			}
			rpcReply(w, r.ID, res, nil)
		default:
			rpcReply(w, r.ID, nil, &rpcError{Code: -32601, Message: "method not found: " + r.Method})
		}
	}
}

// callTool runs a tool; tool failures (e.g. access denied) are reported as
// results with isError so the agent can read them.
func (a *API) callTool(req *http.Request, name string, args json.RawMessage) (text string, structured any, isError bool, rpcErr *rpcError) {
	fail := func(err error) (string, any, bool, *rpcError) {
		var se *StoreError
		if errors.As(err, &se) {
			return se.Message, nil, true, nil
		}
		_, _, msg := catalog.ClassifyTransportErr(err)
		return msg, nil, true, nil
	}
	switch name {
	case "list_models":
		var p struct {
			Cluster string `json:"cluster"`
		}
		_ = json.Unmarshal(args, &p)
		entries, truncated := a.index(req, p.Cluster)
		if entries == nil {
			entries = []IndexEntry{}
		}
		out := map[string]any{"models": entries, "truncated": truncated}
		b, _ := json.MarshalIndent(out, "", "  ")
		return string(b), out, false, nil
	case "get_model":
		var p struct {
			Cluster   string   `json:"cluster"`
			Warehouse string   `json:"warehouse"`
			Namespace []string `json:"namespace"`
			Model     string   `json:"model"`
			Format    string   `json:"format"`
		}
		if err := json.Unmarshal(args, &p); err != nil {
			return "", nil, false, &rpcError{Code: -32602, Message: "invalid arguments"}
		}
		client, ok := a.Deps.Clients[p.Cluster]
		if !ok {
			return "unknown cluster " + p.Cluster, nil, true, nil
		}
		ns, err := catalog.ValidNamespaceLevels(p.Namespace)
		if err != nil || catalog.ValidWarehouse(p.Warehouse) != nil || ValidModelName(p.Model) != nil {
			return "invalid warehouse, namespace or model name", nil, true, nil
		}
		r := withCluster(req, p.Cluster)
		obj, err := a.Store.Get(r, p.Cluster, client, Key(p.Warehouse, ns, p.Model), "", a.Cfg.MaxModelBytes)
		if err != nil {
			return fail(err)
		}
		if p.Format == "json" {
			m, ps, err := Parse(obj.Body, a.limits())
			if err != nil || len(ps) > 0 {
				return "the stored document is not a valid Ossie model", nil, true, nil
			}
			b, _ := MarshalJSON(m)
			return string(b), m, false, nil
		}
		return string(obj.Body), nil, false, nil
	case "search_semantics":
		var p struct {
			Query   string `json:"query"`
			Cluster string `json:"cluster"`
		}
		_ = json.Unmarshal(args, &p)
		q := strings.TrimSpace(p.Query)
		if len([]rune(q)) < 2 || len(q) > 100 {
			return "query must be 2-100 characters", nil, true, nil
		}
		hits, truncated := a.search(req, q, p.Cluster)
		if hits == nil {
			hits = []SearchHit{}
		}
		out := map[string]any{"results": hits, "truncated": truncated}
		b, _ := json.MarshalIndent(out, "", "  ")
		return string(b), out, false, nil
	}
	return "", nil, false, &rpcError{Code: -32602, Message: "unknown tool: " + name}
}

func contextWithRoute(req *http.Request, rc *chi.Context) context.Context {
	return context.WithValue(req.Context(), chi.RouteCtxKey, rc)
}
