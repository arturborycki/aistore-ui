package catalog

import (
	"context"
	"encoding/json"
	"encoding/xml"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/arturborycki/aistore-ui/backend/internal/aistor"
	"github.com/arturborycki/aistore-ui/backend/internal/apierr"
	"github.com/arturborycki/aistore-ui/backend/internal/session"
)

const (
	maxRedactedResponse = 64 << 20
	maxStreamedResponse = 256 << 20
)

// passHeaders are upstream response headers forwarded to the browser.
var passHeaders = []string{"Content-Type", "ETag", "X-Minio-Ui-List-Token", "X-Minio-Ui-Total-Count"}

// AuditEvent describes one mutating catalog operation.
type AuditEvent struct {
	Operation  string            `json:"operation"`
	Action     string            `json:"action"`
	Cluster    string            `json:"cluster"`
	Resource   string            `json:"resource"`
	ARN        string            `json:"arn"`
	Params     map[string]string `json:"params,omitempty"`
	Status     int               `json:"status"`
	Outcome    string            `json:"outcome"` // success | denied | failure
	Error      string            `json:"error,omitempty"`
	DurationMs int64             `json:"durationMs"`
}

// Deps are the services the catalog handler needs from the server.
type Deps struct {
	Clients map[string]*aistor.Client
	// Credentials returns the caller's credentials for cluster. When force is
	// true cached credentials must be discarded and re-obtained.
	Credentials func(r *http.Request, cluster string, force bool) (*session.Credentials, error)
	// StepUpSatisfied reports whether the caller re-authenticated recently.
	StepUpSatisfied func(r *http.Request) bool
	Audit           func(r *http.Request, ev AuditEvent)
	RequestID       func(r *http.Request) string
	MaxBodyBytes    int64
	PreviewMaxRows  int
	Log             *slog.Logger
}

// Mount registers every route of the allow-list under /c/{cluster}.
func Mount(r chi.Router, d Deps) {
	r.Route("/c/{cluster}", func(r chi.Router) {
		for _, rt := range Routes(d.PreviewMaxRows) {
			rt := rt
			r.Method(rt.Method, rt.Pattern, http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				serve(w, req, rt, &d)
			}))
		}
		mountSearch(r, &d)
		r.NotFound(func(w http.ResponseWriter, _ *http.Request) {
			apierr.Write(w, http.StatusNotFound, "NotFound", "unknown catalog operation")
		})
		r.MethodNotAllowed(func(w http.ResponseWriter, _ *http.Request) {
			apierr.Write(w, http.StatusMethodNotAllowed, "MethodNotAllowed", "method not allowed for this catalog resource")
		})
	})
}

func extractParams(req *http.Request) (*Params, error) {
	p := &Params{}
	if v := chi.URLParam(req, "wh"); v != "" {
		dv, err := url.PathUnescape(v)
		if err != nil {
			return nil, invalid("invalid warehouse")
		}
		if err := ValidWarehouse(dv); err != nil {
			return nil, err
		}
		p.Warehouse = dv
	}
	if v := chi.URLParam(req, "ns"); v != "" {
		levels, err := ParseNamespace(v)
		if err != nil {
			return nil, err
		}
		p.Namespace = levels
	}
	for _, k := range []string{"table", "view"} {
		if v := chi.URLParam(req, k); v != "" {
			dv, err := url.PathUnescape(v)
			if err != nil {
				return nil, invalid("invalid %s name", k)
			}
			if err := ValidName(k, dv); err != nil {
				return nil, err
			}
			p.Name = dv
		}
	}
	if v := chi.URLParam(req, "type"); v != "" {
		ok := false
		for _, t := range MaintenanceTypes {
			ok = ok || v == t
		}
		if !ok {
			return nil, invalid("unknown maintenance type %q", v)
		}
		p.Type = v
	}
	return p, nil
}

func resourceLabel(cluster string, p *Params) string {
	parts := []string{cluster}
	if p.Warehouse != "" {
		parts = append(parts, p.Warehouse)
	}
	if len(p.Namespace) > 0 {
		parts = append(parts, p.NamespaceString())
	}
	if p.Name != "" {
		parts = append(parts, p.Name)
	}
	return strings.Join(parts, "/")
}

func serve(w http.ResponseWriter, req *http.Request, rt *Route, d *Deps) {
	start := time.Now()
	cluster := chi.URLParam(req, "cluster")
	client, ok := d.Clients[cluster]
	if !ok {
		apierr.Write(w, http.StatusNotFound, "NoSuchCluster", "unknown cluster")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Aistor-Operation", rt.Operation)
	if rt.Action != "" {
		w.Header().Set("X-Aistor-Action", rt.Action)
	}

	p, err := extractParams(req)
	if err != nil {
		writeErr(w, err)
		return
	}
	w.Header().Set("X-Aistor-Resource", rt.Resource(p))

	q, err := ApplyQuery(rt.Query, req.URL.Query())
	if err != nil {
		writeErr(w, err)
		return
	}
	if rt.FixedQuery != nil {
		for k, vs := range rt.FixedQuery(p) {
			q[k] = vs
		}
	}

	var body []byte
	if rt.Body != nil {
		raw, err := io.ReadAll(http.MaxBytesReader(w, req.Body, d.MaxBodyBytes))
		if err != nil {
			apierr.Write(w, http.StatusRequestEntityTooLarge, "RequestTooLarge", "request body too large")
			return
		}
		if ct, _, _ := mime.ParseMediaType(req.Header.Get("Content-Type")); ct != "application/json" {
			apierr.Write(w, http.StatusUnsupportedMediaType, "UnsupportedMediaType", "request body must be application/json")
			return
		}
		body, err = rt.Body(p, raw)
		if err != nil {
			writeErr(w, err)
			return
		}
	} else if req.ContentLength > 0 {
		apierr.Write(w, http.StatusBadRequest, "ValidationError", "this operation takes no request body")
		return
	}

	if rt.StepUp != nil && rt.StepUp(req.URL.Query()) && !d.StepUpSatisfied(req) {
		apierr.Write(w, http.StatusForbidden, "StepUpRequired", "this operation requires you to confirm your identity again")
		return
	}

	ev := AuditEvent{Operation: rt.Operation, Action: rt.Action, Cluster: cluster, Resource: resourceLabel(cluster, p), ARN: rt.Resource(p)}
	if target := bodyTarget(body); target != "" {
		ev.Resource += "/" + target
	}
	if rt.Mutating() && len(q) > 0 {
		ev.Params = map[string]string{}
		for k := range q {
			ev.Params[k] = strings.Join(q[k], ",")
		}
	}
	finish := func(status int, errMsg string) {
		if !rt.Mutating() || d.Audit == nil {
			return
		}
		ev.Status = status
		ev.Error = errMsg
		ev.DurationMs = time.Since(start).Milliseconds()
		switch {
		case status >= 200 && status < 300:
			ev.Outcome = "success"
		case status == http.StatusForbidden || status == http.StatusUnauthorized:
			ev.Outcome = "denied"
		default:
			ev.Outcome = "failure"
		}
		d.Audit(req, ev)
	}

	upReq := &aistor.Request{Method: rt.Method, Segments: rt.Upstream(p), Query: q, Body: body, RequestID: d.RequestID(req)}
	resp, err := doWithRefresh(req, client, cluster, upReq, d)
	if err != nil {
		status, code, msg := classifyTransportErr(err)
		finish(status, msg)
		apierr.Write(w, status, code, msg)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		status, payload, msg := normalizeUpstreamError(resp)
		finish(status, msg)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write(payload)
		return
	}

	for _, h := range passHeaders {
		if v := resp.Header.Get(h); v != "" {
			w.Header().Set(h, v)
		}
	}
	if rt.Redact {
		raw, err := io.ReadAll(io.LimitReader(resp.Body, maxRedactedResponse+1))
		if err != nil || len(raw) > maxRedactedResponse {
			finish(http.StatusBadGateway, "upstream response too large or unreadable")
			apierr.Write(w, http.StatusBadGateway, "UpstreamError", "catalog response too large or unreadable")
			return
		}
		out := Redact(raw)
		w.Header().Del("ETag")
		w.WriteHeader(resp.StatusCode)
		_, _ = w.Write(out)
		finish(resp.StatusCode, "")
		return
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, io.LimitReader(resp.Body, maxStreamedResponse))
	finish(resp.StatusCode, "")
}

// doWithRefresh sends the request; if AIStor rejects the credentials as expired
// or unknown, it obtains fresh credentials once and retries. A rejected
// request was never executed, so retrying is safe for every method.
func doWithRefresh(req *http.Request, client *aistor.Client, cluster string, upReq *aistor.Request, d *Deps) (*http.Response, error) {
	creds, err := d.Credentials(req, cluster, false)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req.Context(), creds, upReq)
	if err != nil || !credentialRejected(resp) {
		return resp, err
	}
	resp.Body.Close()
	creds, err = d.Credentials(req, cluster, true)
	if err != nil {
		return nil, err
	}
	return client.Do(req.Context(), creds, upReq)
}

var credentialErrorCodes = []string{"ExpiredToken", "InvalidAccessKeyId", "InvalidTokenId", "InvalidClientTokenId", "TokenRefreshRequired"}

// credentialRejected peeks at a 400/401/403 response to see whether it is a
// credential problem rather than an authorization decision.
func credentialRejected(resp *http.Response) bool {
	if resp.StatusCode != http.StatusForbidden && resp.StatusCode != http.StatusBadRequest && resp.StatusCode != http.StatusUnauthorized {
		return false
	}
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	resp.Body.Close()
	resp.Body = io.NopCloser(strings.NewReader(string(raw)))
	s := string(raw)
	for _, c := range credentialErrorCodes {
		if strings.Contains(s, c) {
			return true
		}
	}
	return false
}

// ErrReauthenticate is returned by Deps.Credentials when the session can no
// longer obtain credentials without the user signing in again.
var ErrReauthenticate = errors.New("re-authentication required")

// ErrCredentialsExpired is returned when the session is still valid but its
// AIStor credentials expired and cannot be renewed without the user's
// password (LDAP and access-key sessions). The UI re-authenticates in place.
var ErrCredentialsExpired = errors.New("AIStor credentials expired")

// ErrClusterUnavailable is returned when credentials for the cluster cannot be obtained.
var ErrClusterUnavailable = errors.New("cluster unavailable for this session")

func classifyTransportErr(err error) (int, string, string) {
	switch {
	case errors.Is(err, ErrReauthenticate):
		return http.StatusUnauthorized, "SessionExpired", "your session has expired; please sign in again"
	case errors.Is(err, ErrCredentialsExpired):
		return http.StatusUnauthorized, "CredentialsExpired", "your AIStor credentials expired; confirm your password to continue"
	case errors.Is(err, ErrClusterUnavailable):
		return http.StatusForbidden, "ClusterUnavailable", err.Error()
	case errors.Is(err, context.Canceled):
		return 499, "ClientClosedRequest", "request cancelled"
	case errors.Is(err, context.DeadlineExceeded):
		return http.StatusGatewayTimeout, "UpstreamTimeout", "the catalog did not respond in time"
	}
	var se *aistor.STSError
	if errors.As(err, &se) {
		return http.StatusUnauthorized, "SessionExpired", "AIStor rejected your identity; please sign in again"
	}
	return http.StatusBadGateway, "UpstreamUnavailable", "the catalog could not be reached"
}

type s3Error struct {
	Code    string `xml:"Code"`
	Message string `xml:"Message"`
}

// normalizeUpstreamError converts any upstream error into the Iceberg
// ErrorModel shape {"error":{"message","type","code"}}.
func normalizeUpstreamError(resp *http.Response) (int, []byte, string) {
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 256<<10))
	status := resp.StatusCode
	var ice struct {
		Error *struct {
			Message string `json:"message"`
			Type    string `json:"type"`
			Code    int    `json:"code"`
		} `json:"error"`
	}
	if json.Unmarshal(raw, &ice) == nil && ice.Error != nil {
		out, _ := json.Marshal(map[string]any{"error": map[string]any{"message": ice.Error.Message, "type": ice.Error.Type, "code": status}})
		return status, out, ice.Error.Type + ": " + ice.Error.Message
	}
	var s3 s3Error
	msg, typ := http.StatusText(status), "UpstreamError"
	if xml.Unmarshal(raw, &s3) == nil && s3.Code != "" {
		typ, msg = s3.Code, s3.Message
	} else if t := strings.TrimSpace(string(raw)); t != "" && len(t) < 512 && !strings.ContainsAny(t, "<{") {
		msg = t
	}
	if status == http.StatusForbidden && typ == "UpstreamError" {
		typ = "AccessDenied"
	}
	return status, apierr.Body(status, typ, msg), typ + ": " + msg
}

func writeErr(w http.ResponseWriter, err error) {
	var ve *ValidationError
	if errors.As(err, &ve) {
		apierr.Write(w, http.StatusBadRequest, "ValidationError", ve.Msg)
		return
	}
	apierr.Write(w, http.StatusInternalServerError, "InternalError", "internal error")
}

// bodyTarget names the entity a create/rename/register request acts on, for audit records.
func bodyTarget(body []byte) string {
	if len(body) == 0 {
		return ""
	}
	var b struct {
		Name        string   `json:"name"`
		Namespace   []string `json:"namespace"`
		Destination *struct {
			Namespace []string `json:"namespace"`
			Name      string   `json:"name"`
		} `json:"destination"`
	}
	if json.Unmarshal(body, &b) != nil {
		return ""
	}
	switch {
	case b.Destination != nil:
		return "→ " + strings.Join(append(append([]string{}, b.Destination.Namespace...), b.Destination.Name), ".")
	case len(b.Namespace) > 0:
		return strings.Join(b.Namespace, ".")
	}
	return b.Name
}
