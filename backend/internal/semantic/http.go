package semantic

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/arturborycki/aistore-ui/backend/internal/aistor"
	"github.com/arturborycki/aistore-ui/backend/internal/apierr"
	"github.com/arturborycki/aistore-ui/backend/internal/catalog"
	"github.com/arturborycki/aistore-ui/backend/internal/config"
)

// API serves semantic models to the UI (session-authenticated) and, through
// Serving, to tools and agents (bearer tokens).
type API struct {
	Cfg   config.Semantic
	Deps  *catalog.Deps
	Store *Store
	// Editor names the caller, recorded on each saved version.
	Editor func(r *http.Request) string
}

func NewAPI(cfg config.Semantic, deps *catalog.Deps, editor func(*http.Request) string) *API {
	return &API{Cfg: cfg, Deps: deps, Store: &Store{Bucket: cfg.Bucket, Deps: deps}, Editor: editor}
}

func (a *API) limits() Limits {
	l := DefaultLimits
	l.MaxBytes = a.Cfg.MaxModelBytes
	return l
}

func (a *API) source() SourceFormatter { return DefaultSource(a.Cfg.CatalogAliases) }

// Mount registers the UI routes under /c/{cluster}/semantic.
func (a *API) Mount(r chi.Router) {
	r.Route("/semantic", func(r chi.Router) {
		r.Get("/search", a.handleSearch)
		r.Post("/validate", a.handleValidate)
		r.Post("/parse", a.handleParse)
		r.Post("/render", a.handleRender)
		r.Post("/generate/wh/{wh}", a.handleGenerate)
		r.Get("/wh/{wh}/usage", a.handleUsage)
		r.Get("/wh/{wh}/ns/{ns}/models", a.handleList)
		r.Post("/wh/{wh}/ns/{ns}/models", a.handleCreate)
		r.Get("/wh/{wh}/ns/{ns}/models/{model}", a.handleGet)
		r.Put("/wh/{wh}/ns/{ns}/models/{model}", a.handlePut)
		r.Delete("/wh/{wh}/ns/{ns}/models/{model}", a.handleDelete)
		r.Get("/wh/{wh}/ns/{ns}/models/{model}/versions", a.handleVersions)
		r.Get("/wh/{wh}/ns/{ns}/models/{model}/drift", a.handleDrift)
		r.Post("/wh/{wh}/ns/{ns}/models/{model}/drift", a.handleFixDrift)
	})
}

// ---------------------------------------------------------------- helpers

type badRequest string

func (b badRequest) Error() string { return string(b) }

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func (a *API) writeErr(w http.ResponseWriter, err error) {
	var se *StoreError
	var br badRequest
	switch {
	case errors.As(err, &se):
		if se.Action != "" {
			w.Header().Set("X-Aistor-Action", se.Action)
			w.Header().Set("X-Aistor-Resource", se.Resource)
		}
		apierr.Write(w, se.Status, se.Type, se.Message)
	case errors.As(err, &br):
		apierr.Write(w, http.StatusBadRequest, "ValidationError", string(br))
	case errors.Is(err, ErrInvalid):
		apierr.Write(w, http.StatusUnprocessableEntity, "InvalidModel", err.Error())
	default:
		status, code, msg := catalog.ClassifyTransportErr(err)
		apierr.Write(w, status, code, msg)
	}
}

type target struct {
	cluster string
	client  *aistor.Client
	wh      string
	ns      []string
	model   string
}

func (t *target) key() string { return Key(t.wh, t.ns, t.model) }

func (t *target) label() string {
	return fmt.Sprintf("%s/%s/%s/%s", t.cluster, t.wh, strings.Join(t.ns, "."), t.model)
}

func (a *API) target(req *http.Request) (*target, error) {
	t := &target{cluster: chi.URLParam(req, "cluster")}
	c, ok := a.Deps.Clients[t.cluster]
	if !ok {
		return nil, &StoreError{Status: http.StatusNotFound, Type: "NoSuchCluster", Message: "unknown cluster"}
	}
	t.client = c
	if v := chi.URLParam(req, "wh"); v != "" {
		wh, err := url.PathUnescape(v)
		if err != nil || catalog.ValidWarehouse(wh) != nil {
			return nil, badRequest("invalid warehouse")
		}
		t.wh = wh
	}
	if v := chi.URLParam(req, "ns"); v != "" {
		ns, err := catalog.ParseNamespace(v)
		if err != nil {
			return nil, badRequest(err.Error())
		}
		t.ns = ns
	}
	if v := chi.URLParam(req, "model"); v != "" {
		m, err := url.PathUnescape(v)
		if err != nil || ValidModelName(m) != nil {
			return nil, badRequest("invalid model name")
		}
		t.model = m
	}
	return t, nil
}

func (a *API) audit(req *http.Request, t *target, op, action string, status int, err error) {
	if a.Deps.Audit == nil {
		return
	}
	ev := catalog.AuditEvent{Operation: op, Action: action, Cluster: t.cluster, Resource: t.label(), ARN: a.Store.arn(t.key()), Status: status}
	switch {
	case err == nil:
		ev.Outcome = "success"
	case status == http.StatusForbidden:
		ev.Outcome, ev.Error = "denied", err.Error()
	default:
		ev.Outcome, ev.Error = "failure", err.Error()
	}
	a.Deps.Audit(req, ev)
}

func statusOf(err error) int {
	var se *StoreError
	if errors.As(err, &se) {
		return se.Status
	}
	if err == nil {
		return http.StatusOK
	}
	s, _, _ := catalog.ClassifyTransportErr(err)
	return s
}

// readModel reads a request body: an Ossie document as YAML or JSON, or
// {"model": {...}} for convenience.
func (a *API) readModel(w http.ResponseWriter, req *http.Request) (*Model, []Problem, error) {
	raw, err := io.ReadAll(http.MaxBytesReader(w, req.Body, int64(a.Cfg.MaxModelBytes)*2+4096))
	if err != nil {
		return nil, nil, fmt.Errorf("%w: request body too large", ErrInvalid)
	}
	ct, _, _ := mime.ParseMediaType(req.Header.Get("Content-Type"))
	switch ct {
	case "application/json":
		var env struct {
			Model json.RawMessage `json:"model"`
		}
		if json.Unmarshal(raw, &env) == nil && len(env.Model) > 0 {
			raw = env.Model
		}
	case "application/yaml", "application/x-yaml", "text/yaml":
	default:
		return nil, nil, badRequest("send the model as application/json or application/yaml")
	}
	return Parse(raw, a.limits())
}

// ---------------------------------------------------------------- list / get

type modelSummary struct {
	Name         string    `json:"name"`
	Key          string    `json:"key"`
	Warehouse    string    `json:"warehouse"`
	Namespace    []string  `json:"namespace"`
	ETag         string    `json:"etag"`
	Size         int64     `json:"size"`
	LastModified time.Time `json:"lastModified"`
	Description  string    `json:"description,omitempty"`
	Datasets     int       `json:"datasets"`
	Metrics      int       `json:"metrics"`
	Relations    int       `json:"relationships"`
	Tables       []string  `json:"tables,omitempty"` // table UUIDs the model covers
	Invalid      bool      `json:"invalid,omitempty"`
}

func (a *API) handleList(w http.ResponseWriter, req *http.Request) {
	t, err := a.target(req)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	list, truncated, err := a.Store.List(req, t.cluster, t.client, NamespacePrefix(t.wh, t.ns), true, 500)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	out := make([]modelSummary, 0, len(list))
	for i, l := range list {
		_, _, name, ok := ParseKey(l.Key)
		if !ok {
			continue
		}
		s := modelSummary{Name: name, Key: l.Key, Warehouse: t.wh, Namespace: t.ns, ETag: l.ETag, Size: l.Size, LastModified: l.LastModified}
		if i < 100 { // details for the first 100
			if obj, err := a.Store.Get(req, t.cluster, t.client, l.Key, "", a.Cfg.MaxModelBytes); err == nil {
				if m, ps, err := Parse(obj.Body, a.limits()); err == nil && len(ps) == 0 {
					s.Description, s.Datasets, s.Metrics, s.Relations = m.Description, len(m.Datasets), len(m.Metrics), len(m.Relationships)
					for _, d := range m.Datasets {
						if x, ok := d.Ext(); ok {
							s.Tables = append(s.Tables, x.TableUUID)
						}
					}
				} else {
					s.Invalid = true
				}
			}
		}
		out = append(out, s)
	}
	writeJSON(w, http.StatusOK, map[string]any{"models": out, "truncated": truncated, "bucket": a.Cfg.Bucket})
}

type modelResponse struct {
	Model        *Model    `json:"model"`
	Raw          string    `json:"raw,omitempty"` // only when the stored document is not a valid model
	ETag         string    `json:"etag"`
	VersionID    string    `json:"versionId,omitempty"`
	LastModified time.Time `json:"lastModified"`
	Editor       string    `json:"editor,omitempty"`
	Key          string    `json:"key"`
	Problems     []Problem `json:"problems"`
}

func (a *API) handleGet(w http.ResponseWriter, req *http.Request) {
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
	w.Header().Set("ETag", `"`+obj.ETag+`"`)
	switch req.URL.Query().Get("format") {
	case "yaml":
		w.Header().Set("Content-Type", "application/yaml; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s%s"`, t.model, FileSuffix))
		_, _ = w.Write(obj.Body)
		return
	case "json":
		m, ps, err := Parse(obj.Body, a.limits())
		if err != nil || len(ps) > 0 {
			apierr.Write(w, http.StatusUnprocessableEntity, "InvalidModel", "the stored document is not a valid Ossie model")
			return
		}
		b, _ := MarshalJSON(m)
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.ossie.json"`, t.model))
		_, _ = w.Write(b)
		return
	}
	resp := modelResponse{ETag: obj.ETag, VersionID: obj.VersionID, LastModified: obj.LastModified, Editor: obj.Editor, Key: t.key(), Problems: []Problem{}}
	m, ps, err := Parse(obj.Body, a.limits())
	switch {
	case err != nil:
		resp.Raw = string(obj.Body)
		resp.Problems = []Problem{errorAt("", "%s", err.Error())}
	case len(ps) > 0:
		resp.Raw = string(obj.Body)
		resp.Problems = ps
	default:
		resp.Model = m
		resp.Problems = append(resp.Problems, Validate(m)...)
	}
	writeJSON(w, http.StatusOK, resp)
}

// ---------------------------------------------------------------- write

type tableRef struct {
	Namespace []string `json:"namespace"`
	Name      string   `json:"name"`
}

func (a *API) generate(r *resolver, wh string, refs []tableRef, m *Model) ([]Dataset, error) {
	var out []Dataset
	for _, ref := range refs {
		ns, err := catalog.ValidNamespaceLevels(ref.Namespace)
		if err != nil {
			return nil, badRequest(err.Error())
		}
		if catalog.ValidName("table", ref.Name) != nil {
			return nil, badRequest("invalid table name")
		}
		t, st, err := r.table(wh, ns, ref.Name)
		if err != nil {
			return nil, err
		}
		if t == nil {
			if st == http.StatusForbidden {
				return nil, &StoreError{Status: http.StatusForbidden, Type: "AccessDenied", Message: fmt.Sprintf("you may not read table %s.%s", strings.Join(ns, "."), ref.Name), Action: "s3tables:GetTable", Resource: "arn:aws:s3tables:::bucket/" + wh + "/table/*"}
			}
			return nil, &StoreError{Status: http.StatusNotFound, Type: "NoSuchTable", Message: fmt.Sprintf("table %s.%s does not exist", strings.Join(ns, "."), ref.Name)}
		}
		d := GenerateDataset(t, UniqueDatasetName(m, t.Name), a.source())
		m.Datasets = append(m.Datasets, d)
		out = append(out, d)
	}
	return out, nil
}

func (a *API) handleGenerate(w http.ResponseWriter, req *http.Request) {
	t, err := a.target(req)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	var body struct {
		Tables   []tableRef `json:"tables"`
		Existing []string   `json:"existing"` // dataset names already in the model
	}
	if err := json.NewDecoder(io.LimitReader(req.Body, 1<<20)).Decode(&body); err != nil || len(body.Tables) == 0 || len(body.Tables) > 100 {
		a.writeErr(w, badRequest("send {tables: [{namespace, name}]} (1-100 tables)"))
		return
	}
	m := &Model{}
	for _, n := range body.Existing {
		m.Datasets = append(m.Datasets, Dataset{Name: n})
	}
	ds, err := a.generate(a.newResolver(req, t.cluster, t.client), t.wh, body.Tables, m)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"datasets": ds})
}

func (a *API) handleCreate(w http.ResponseWriter, req *http.Request) {
	t, err := a.target(req)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	var body struct {
		Name        string     `json:"name"`
		Description string     `json:"description"`
		Tables      []tableRef `json:"tables"`
		Model       *Model     `json:"model"` // an imported document (JSON)
		Raw         string     `json:"raw"`   // an imported document (YAML or JSON text)
	}
	if err := json.NewDecoder(io.LimitReader(req.Body, int64(a.Cfg.MaxModelBytes)*2)).Decode(&body); err != nil {
		a.writeErr(w, badRequest("invalid request body"))
		return
	}
	if err := ValidModelName(body.Name); err != nil {
		a.writeErr(w, badRequest(err.Error()))
		return
	}
	t.model = body.Name
	m := body.Model
	if body.Raw != "" {
		parsed, ps, err := Parse([]byte(body.Raw), a.limits())
		if err != nil {
			a.writeErr(w, err)
			return
		}
		if len(ps) > 0 {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"error": map[string]any{"type": "InvalidModel", "message": "the document does not conform to the Ossie schema", "code": 422}, "problems": ps})
			return
		}
		m = parsed
	}
	if m == nil {
		m = &Model{Version: SpecVersion, Name: body.Name, Description: body.Description}
	}
	m.Name = body.Name
	r := a.newResolver(req, t.cluster, t.client)
	if _, err := a.generate(r, t.wh, body.Tables, m); err != nil {
		a.writeErr(w, err)
		return
	}
	if len(m.Datasets) == 0 {
		a.writeErr(w, badRequest("a model needs at least one dataset: choose one or more tables"))
		return
	}
	a.save(w, req, t, m, "", http.StatusCreated, "CreateSemanticModel")
}

func (a *API) handlePut(w http.ResponseWriter, req *http.Request) {
	t, err := a.target(req)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	ifMatch := req.Header.Get("If-Match")
	if ifMatch == "" {
		apierr.Write(w, http.StatusPreconditionRequired, "PreconditionRequired", "send If-Match with the ETag of the version you edited")
		return
	}
	m, ps, err := a.readModel(w, req)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	if len(ps) > 0 {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"error": map[string]any{"type": "InvalidModel", "message": "the model does not conform to the Ossie schema", "code": 422}, "problems": ps})
		return
	}
	if m.Name != t.model {
		a.writeErr(w, badRequest(fmt.Sprintf("the document's name (%q) must match the model name %q", m.Name, t.model)))
		return
	}
	a.save(w, req, t, m, ifMatch, http.StatusOK, "SaveSemanticModel")
}

// save validates, canonicalizes and writes a model.
func (a *API) save(w http.ResponseWriter, req *http.Request, t *target, m *Model, ifMatch string, okStatus int, op string) {
	m.Version = SpecVersion
	b, err := MarshalYAML(m)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	// Round-trip through the parser: what we store must be schema-valid.
	parsed, ps, err := Parse(b, a.limits())
	if err != nil {
		a.writeErr(w, err)
		return
	}
	ps = append(ps, Validate(parsed)...)
	if HasErrors(ps) {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"error": map[string]any{"type": "InvalidModel", "message": "fix the errors in the model before saving", "code": 422}, "problems": ps})
		return
	}
	r := a.newResolver(req, t.cluster, t.client)
	ps = append(ps, r.catalogProblems(parsed, r.resolveAll(parsed))...)
	etag, version, err := a.Store.Put(req, t.cluster, t.client, t.key(), b, ifMatch, a.Editor(req))
	if err != nil {
		var se *StoreError
		if ifMatch == "" && errors.As(err, &se) && se.Type == "ModelConflict" {
			se.Type, se.Message = "ModelExists", fmt.Sprintf("a model named %q already exists in this namespace", t.model)
		}
		a.audit(req, t, op, "s3:PutObject", statusOf(err), err)
		a.writeErr(w, err)
		return
	}
	a.audit(req, t, op, "s3:PutObject", okStatus, nil)
	w.Header().Set("ETag", `"`+etag+`"`)
	if ps == nil {
		ps = []Problem{}
	}
	writeJSON(w, okStatus, map[string]any{"etag": etag, "versionId": version, "key": t.key(), "model": parsed, "problems": ps})
}

func (a *API) handleDelete(w http.ResponseWriter, req *http.Request) {
	t, err := a.target(req)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	ifMatch := req.Header.Get("If-Match")
	if ifMatch == "" {
		apierr.Write(w, http.StatusPreconditionRequired, "PreconditionRequired", "send If-Match with the ETag of the version you are deleting")
		return
	}
	if !a.Deps.StepUpSatisfied(req) {
		apierr.Write(w, http.StatusForbidden, "StepUpRequired", "this operation requires you to confirm your identity again")
		return
	}
	err = a.Store.Delete(req, t.cluster, t.client, t.key(), ifMatch)
	a.audit(req, t, "DeleteSemanticModel", "s3:DeleteObject", statusOf(err), err)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) handleVersions(w http.ResponseWriter, req *http.Request) {
	t, err := a.target(req)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	vs, err := a.Store.Versions(req, t.cluster, t.client, t.key(), 100, 30)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	if vs == nil {
		vs = []Version{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"versions": vs})
}

// ---------------------------------------------------------------- validate / drift

func (a *API) handleValidate(w http.ResponseWriter, req *http.Request) {
	t, err := a.target(req)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	m, ps, err := a.readModel(w, req)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"problems": []Problem{errorAt("", "%s", strings.TrimPrefix(err.Error(), ErrInvalid.Error()+": "))}})
		return
	}
	if len(ps) == 0 {
		ps = append(ps, Validate(m)...)
		r := a.newResolver(req, t.cluster, t.client)
		ps = append(ps, r.catalogProblems(m, r.resolveAll(m))...)
	}
	if ps == nil {
		ps = []Problem{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"problems": ps})
}

// handleParse turns YAML or JSON text into a model (for the YAML editor),
// reporting schema and structural problems.
func (a *API) handleParse(w http.ResponseWriter, req *http.Request) {
	var body struct {
		Raw string `json:"raw"`
	}
	if err := json.NewDecoder(io.LimitReader(req.Body, int64(a.Cfg.MaxModelBytes)*2)).Decode(&body); err != nil {
		a.writeErr(w, badRequest("send {raw: <YAML or JSON text>}"))
		return
	}
	m, ps, err := Parse([]byte(body.Raw), a.limits())
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"model": nil, "problems": []Problem{errorAt("", "%s", strings.TrimPrefix(err.Error(), ErrInvalid.Error()+": "))}})
		return
	}
	if len(ps) == 0 {
		ps = Validate(m)
	}
	if ps == nil {
		ps = []Problem{}
	}
	var out *Model
	if !HasErrors(ps) || m != nil {
		out = m
	}
	writeJSON(w, http.StatusOK, map[string]any{"model": out, "problems": ps})
}

// handleRender returns the canonical YAML of a (draft) model, for previews
// and diffs that must match what will be stored.
func (a *API) handleRender(w http.ResponseWriter, req *http.Request) {
	var body struct {
		Model *Model `json:"model"`
	}
	if err := json.NewDecoder(io.LimitReader(req.Body, int64(a.Cfg.MaxModelBytes)*2)).Decode(&body); err != nil || body.Model == nil {
		a.writeErr(w, badRequest("send {model: {...}}"))
		return
	}
	b, err := MarshalYAML(body.Model)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/yaml; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(b)
}

type datasetStatus struct {
	Dataset string `json:"dataset"`
	Table   string `json:"table,omitempty"`
	UUID    string `json:"uuid,omitempty"`
	Tracked bool   `json:"tracked"`
	Moved   bool   `json:"moved,omitempty"`
	Reason  string `json:"reason,omitempty"`
}

func (a *API) driftFor(req *http.Request, t *target) (*Object, *Model, []Resolution, []DriftItem, error) {
	obj, err := a.Store.Get(req, t.cluster, t.client, t.key(), "", a.Cfg.MaxModelBytes)
	if err != nil {
		return nil, nil, nil, nil, err
	}
	m, ps, err := Parse(obj.Body, a.limits())
	if err != nil {
		return nil, nil, nil, nil, err
	}
	if len(ps) > 0 {
		return nil, nil, nil, nil, fmt.Errorf("%w: the stored document does not conform to the Ossie schema", ErrInvalid)
	}
	res := a.newResolver(req, t.cluster, t.client).resolveAll(m)
	return obj, m, res, DetectDrift(m, res), nil
}

func (a *API) handleDrift(w http.ResponseWriter, req *http.Request) {
	t, err := a.target(req)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	obj, m, res, items, err := a.driftFor(req, t)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	st := make([]datasetStatus, len(res))
	for i, r := range res {
		st[i] = datasetStatus{Dataset: m.Datasets[i].Name, Tracked: r.Tracked, Moved: r.Moved, Reason: r.Reason}
		if r.Table != nil {
			st[i].Table, st[i].UUID = r.Table.Label(), r.Table.UUID
		}
	}
	if items == nil {
		items = []DriftItem{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"etag": obj.ETag, "items": items, "datasets": st})
}

func (a *API) handleFixDrift(w http.ResponseWriter, req *http.Request) {
	t, err := a.target(req)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	var body struct {
		IDs []string `json:"ids"`
	}
	_ = json.NewDecoder(io.LimitReader(req.Body, 1<<20)).Decode(&body)
	obj, m, res, items, err := a.driftFor(req, t)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	fixed := ApplyFixes(m, res, items, body.IDs, a.source())
	// The fixed model is returned for review; the client saves it with If-Match: etag.
	writeJSON(w, http.StatusOK, map[string]any{"etag": obj.ETag, "model": fixed, "problems": Validate(fixed)})
}

// ---------------------------------------------------------------- usage / search

type scanned struct {
	Key   string
	WH    string
	NS    []string
	Name  string
	Model *Model
}

// scan reads models under prefix (recursively), within the configured budget.
func (a *API) scan(req *http.Request, cluster string, client *aistor.Client, prefix string, budget *int) ([]scanned, bool) {
	list, truncated, err := a.Store.List(req, cluster, client, prefix, false, *budget)
	if err != nil {
		return nil, false
	}
	var out []scanned
	for _, l := range list {
		if *budget <= 0 {
			return out, true
		}
		*budget--
		wh, ns, name, ok := ParseKey(l.Key)
		if !ok {
			continue
		}
		obj, err := a.Store.Get(req, cluster, client, l.Key, "", a.Cfg.MaxModelBytes)
		if err != nil {
			continue
		}
		m, ps, err := Parse(obj.Body, a.limits())
		if err != nil || len(ps) > 0 {
			continue
		}
		out = append(out, scanned{Key: l.Key, WH: wh, NS: ns, Name: name, Model: m})
	}
	return out, truncated
}

type usage struct {
	Model         string   `json:"model"`
	Warehouse     string   `json:"warehouse"`
	Namespace     []string `json:"namespace"`
	Dataset       string   `json:"dataset"`
	Fields        []usedBy `json:"fields"`
	PrimaryKey    []string `json:"primaryKey,omitempty"`
	Relationships []string `json:"relationships,omitempty"`
	Metrics       []string `json:"metrics,omitempty"`
}

type usedBy struct {
	Field   string `json:"field"`
	FieldID int    `json:"fieldId,omitempty"`
	Column  string `json:"column,omitempty"`
}

// handleUsage lists the models (in a warehouse) that use a table, and which
// fields read which columns, for the table's Semantics tab and schema warnings.
func (a *API) handleUsage(w http.ResponseWriter, req *http.Request) {
	t, err := a.target(req)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	q := req.URL.Query()
	uuid := q.Get("table")
	ns, _ := catalog.ParseNamespace(q.Get("namespace"))
	name := q.Get("name")
	if uuid == "" && name == "" {
		a.writeErr(w, badRequest("send table=<uuid> and/or namespace=&name="))
		return
	}
	budget := a.Cfg.MaxScan
	models, truncated := a.scan(req, t.cluster, t.client, t.wh+"/", &budget)
	src := a.source()
	var out []usage
	for _, s := range models {
		for _, d := range s.Model.Datasets {
			x, tracked := d.Ext()
			match := tracked && uuid != "" && x.TableUUID == uuid
			if !match && name != "" && len(ns) > 0 {
				match = d.Source == src(t.wh, ns, name) || (tracked && x.Warehouse == t.wh && x.Table == name && strings.Join(x.Namespace, "\x1f") == strings.Join(ns, "\x1f"))
			}
			if !match {
				continue
			}
			u := usage{Model: s.Name, Warehouse: s.WH, Namespace: s.NS, Dataset: d.Name, PrimaryKey: d.PrimaryKey, Fields: []usedBy{}}
			for _, f := range d.Fields {
				ub := usedBy{Field: f.Name}
				if fx, ok := f.Ext(); ok {
					ub.FieldID = fx.FieldID
				}
				if _, e, ok := f.Expression.SQL(); ok {
					if p, simple := SimpleColumn(e); simple {
						ub.Column = p
					}
				}
				u.Fields = append(u.Fields, ub)
			}
			for _, r := range s.Model.Relationships {
				if r.From == d.Name || r.To == d.Name {
					u.Relationships = append(u.Relationships, r.Name)
				}
			}
			for _, mt := range s.Model.Metrics {
				for _, de := range mt.Expression.Dialects {
					uses := false
					for _, r := range Refs(de.Expression) {
						if len(r.Parts) >= 2 && r.Parts[0] == d.Name {
							uses = true
						}
					}
					if uses {
						u.Metrics = append(u.Metrics, mt.Name)
						break
					}
				}
			}
			out = append(out, u)
		}
	}
	if out == nil {
		out = []usage{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"usage": out, "truncated": truncated})
}

// SearchHit is a semantic search result.
type SearchHit struct {
	Kind      string   `json:"kind"` // model | dataset | field | metric | relationship
	Cluster   string   `json:"cluster,omitempty"`
	Warehouse string   `json:"warehouse"`
	Namespace []string `json:"namespace"`
	Model     string   `json:"model"`
	Dataset   string   `json:"dataset,omitempty"`
	Name      string   `json:"name"`
	Match     string   `json:"match,omitempty"` // the synonym or description text that matched, if not the name
	rank      int
}

func matchText(q string, name string, extra ...string) (int, string, bool) {
	n := lower(name)
	switch {
	case n == q:
		return 0, "", true
	case strings.HasPrefix(n, q):
		return 1, "", true
	case strings.Contains(n, q):
		return 2, "", true
	}
	for _, e := range extra {
		if strings.Contains(lower(e), q) {
			return 3, e, true
		}
	}
	return 0, "", false
}

// SearchModels finds names, synonyms and descriptions matching q.
func SearchModels(models []scanned, q string, limit int) []SearchHit {
	q = lower(strings.TrimSpace(q))
	var hits []SearchHit
	add := func(h SearchHit, rank int, match string, ok bool) {
		if ok {
			h.rank, h.Match = rank, match
			hits = append(hits, h)
		}
	}
	for _, s := range models {
		m := s.Model
		base := SearchHit{Warehouse: s.WH, Namespace: s.NS, Model: s.Name}
		h := base
		h.Kind, h.Name = "model", s.Name
		r, mt, ok := matchText(q, s.Name, append([]string{m.Description}, AIContextText(m.AIContext)...)...)
		add(h, r, mt, ok)
		for _, d := range m.Datasets {
			h := base
			h.Kind, h.Name, h.Dataset = "dataset", d.Name, d.Name
			r, mt, ok := matchText(q, d.Name, append([]string{d.Description}, Synonyms(d.AIContext)...)...)
			add(h, r, mt, ok)
			for _, f := range d.Fields {
				h := base
				h.Kind, h.Name, h.Dataset = "field", f.Name, d.Name
				r, mt, ok := matchText(q, f.Name, append([]string{f.Description}, Synonyms(f.AIContext)...)...)
				add(h, r, mt, ok)
			}
		}
		for _, x := range m.Metrics {
			h := base
			h.Kind, h.Name = "metric", x.Name
			r, mt, ok := matchText(q, x.Name, append([]string{x.Description}, Synonyms(x.AIContext)...)...)
			add(h, r, mt, ok)
		}
		for _, x := range m.Relationships {
			h := base
			h.Kind, h.Name = "relationship", x.Name
			r, mt, ok := matchText(q, x.Name)
			add(h, r, mt, ok)
		}
	}
	order := map[string]int{"metric": 0, "model": 1, "dataset": 2, "field": 3, "relationship": 4}
	sort.SliceStable(hits, func(i, j int) bool {
		if hits[i].rank != hits[j].rank {
			return hits[i].rank < hits[j].rank
		}
		return order[hits[i].Kind] < order[hits[j].Kind]
	})
	if len(hits) > limit {
		hits = hits[:limit]
	}
	return hits
}

// warehouses lists the caller's warehouses.
func (a *API) warehouses(req *http.Request, cluster string, client *aistor.Client) []string {
	r := a.newResolver(req, cluster, client)
	st, body, err := r.get([]string{"warehouses"}, url.Values{"pageSize": {"1000"}})
	if err != nil || st != http.StatusOK {
		return nil
	}
	var resp struct {
		Warehouses []string `json:"warehouses"`
	}
	_ = json.Unmarshal(body, &resp)
	return resp.Warehouses
}

// ScanCluster reads every model the caller can list on a cluster.
func (a *API) ScanCluster(req *http.Request, cluster string, client *aistor.Client) ([]scanned, bool) {
	budget := a.Cfg.MaxScan
	var all []scanned
	truncated := false
	for _, wh := range a.warehouses(req, cluster, client) {
		if budget <= 0 {
			truncated = true
			break
		}
		ms, tr := a.scan(req, cluster, client, wh+"/", &budget)
		all = append(all, ms...)
		truncated = truncated || tr
	}
	return all, truncated
}

func (a *API) handleSearch(w http.ResponseWriter, req *http.Request) {
	t, err := a.target(req)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	q := strings.TrimSpace(req.URL.Query().Get("q"))
	if len([]rune(q)) < 2 || len(q) > 100 {
		a.writeErr(w, badRequest("q must be 2-100 characters"))
		return
	}
	models, truncated := a.ScanCluster(req, t.cluster, t.client)
	hits := SearchModels(models, q, 50)
	if hits == nil {
		hits = []SearchHit{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"results": hits, "truncated": truncated, "models": len(models)})
}
