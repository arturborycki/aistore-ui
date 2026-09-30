// Package server wires the HTTP API: authentication, sessions, the catalog
// allow-list proxy, activity, health, and the embedded single-page app.
package server

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/redis/go-redis/v9"

	"github.com/arturborycki/aistore-ui/backend/internal/aistor"
	"github.com/arturborycki/aistore-ui/backend/internal/apierr"
	"github.com/arturborycki/aistore-ui/backend/internal/audit"
	"github.com/arturborycki/aistore-ui/backend/internal/auth"
	"github.com/arturborycki/aistore-ui/backend/internal/catalog"
	"github.com/arturborycki/aistore-ui/backend/internal/config"
	"github.com/arturborycki/aistore-ui/backend/internal/inspect"
	"github.com/arturborycki/aistore-ui/backend/internal/semantic"
	"github.com/arturborycki/aistore-ui/backend/internal/session"
)

// credentialSkew is how long before expiry credentials are proactively renewed.
const credentialSkew = 2 * time.Minute

type Server struct {
	cfg      *config.Config
	log      *slog.Logger
	sessions *session.Manager
	clients  map[string]*aistor.Client
	oidc     *auth.OIDC
	audit    *audit.Logger
	metrics  *metrics
	static   fs.FS
	version  string

	apiLimiter    rateLimiter
	loginLimiter  rateLimiter
	bearerLimiter rateLimiter
	stsCache      *stsCache

	// refresh serialises credential renewal per session+cluster.
	refreshMu  sync.Mutex
	refreshing map[string]*sync.Mutex
}

type Options struct {
	Config   *config.Config
	Log      *slog.Logger
	Sessions *session.Manager
	Audit    *audit.Logger
	Static   fs.FS // built SPA; may be nil
	// Redis, when set, makes rate limits shared across replicas.
	Redis   redis.UniversalClient
	Version string
}

func New(o Options) (*Server, error) {
	s := &Server{
		cfg: o.Config, log: o.Log, sessions: o.Sessions, audit: o.Audit, static: o.Static, version: o.Version,
		clients:       map[string]*aistor.Client{},
		metrics:       newMetrics(),
		apiLimiter:    newLimiter(o.Config.Limits.RequestsPerMinute),
		loginLimiter:  newLimiter(o.Config.Limits.LoginPerMinute),
		bearerLimiter: newLimiter(o.Config.Semantic.Serving.RequestsPerMinute),
		stsCache:      &stsCache{m: map[string]*session.Credentials{}},
		refreshing:    map[string]*sync.Mutex{},
	}
	for _, cl := range o.Config.Clusters {
		c, err := aistor.NewClient(cl)
		if err != nil {
			return nil, err
		}
		s.clients[cl.ID] = c
	}
	if o.Redis != nil {
		s.apiLimiter = newRedisLimiter(o.Redis, "api", o.Config.Limits.RequestsPerMinute, o.Log)
		s.loginLimiter = newRedisLimiter(o.Redis, "login", o.Config.Limits.LoginPerMinute, o.Log)
		s.bearerLimiter = newRedisLimiter(o.Redis, "bearer", o.Config.Semantic.Serving.RequestsPerMinute, o.Log)
	}
	if o.Config.Auth.OIDC.Enabled {
		oc, err := auth.NewOIDC(o.Config.Auth.OIDC, o.Config.PublicURL().String()+"/auth/oidc/callback")
		if err != nil {
			return nil, err
		}
		s.oidc = oc
	}
	return s, nil
}

// Metrics returns the Prometheus handler (served on a separate listener).
func (s *Server) Metrics() http.Handler { return s.metrics.handler() }

func (s *Server) Handler() http.Handler {
	r := chi.NewRouter()
	r.Use(s.withRequestMeta, s.accessLog, s.securityHeaders)

	r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	r.Get("/readyz", s.handleReady)
	if s.cfg.Semantic.Serving.Enabled && s.oidc != nil {
		s.mountOssie(r)
	}

	r.Group(func(r chi.Router) {
		r.Use(s.loadSession, s.csrf)

		r.Route("/auth", func(r chi.Router) {
			r.Get("/providers", s.handleProviders)
			r.Group(func(r chi.Router) {
				r.Use(s.rateLimit(s.loginLimiter, true))
				r.Get("/oidc/login", s.handleOIDCLogin)
				r.Get("/oidc/callback", s.handleOIDCCallback)
				r.Post("/ldap/login", s.handleLDAPLogin)
				r.Post("/builtin/login", s.handleBuiltinLogin)
				r.With(s.requireSession).Post("/step-up", s.handlePasswordStepUp)
			})
			r.Post("/logout", s.handleLogout)
			r.With(s.requireSession).Get("/me", s.handleMe)
		})

		r.Route("/api", func(r chi.Router) {
			r.Use(s.requireSession, s.rateLimit(s.apiLimiter, false))
			r.Get("/activity", s.handleActivity)
			s.mountSessions(r)
			catalog.Mount(r, catalog.Deps{
				Clients:         s.clients,
				Credentials:     s.credentials,
				StepUpSatisfied: s.stepUpSatisfied,
				Audit:           s.recordCatalog,
				RequestID:       requestID,
				MaxBodyBytes:    s.cfg.Limits.MaxBodyBytes,
				PreviewMaxRows:  s.cfg.Limits.PreviewMaxRows,
				Log:             s.log,
				Extra: func(r chi.Router, d *catalog.Deps) {
					inspect.NewAPI(d).Mount(r)
					if s.cfg.Semantic.Enabled {
						semantic.NewAPI(s.cfg.Semantic, d, s.editorName).Mount(r)
					}
				},
			})
			r.NotFound(func(w http.ResponseWriter, _ *http.Request) {
				apierr.Write(w, http.StatusNotFound, "NotFound", "unknown API route")
			})
		})
	})

	r.NotFound(s.spaHandler().ServeHTTP)
	return r
}

func (s *Server) handleReady(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := s.sessions.Ping(ctx); err != nil {
		apierr.Write(w, http.StatusServiceUnavailable, "NotReady", "session store unavailable")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---------------------------------------------------------------- credentials

func (s *Server) lockFor(key string) *sync.Mutex {
	s.refreshMu.Lock()
	defer s.refreshMu.Unlock()
	m, ok := s.refreshing[key]
	if !ok {
		m = &sync.Mutex{}
		s.refreshing[key] = m
	}
	return m
}

// credentials returns the caller's STS credentials for cluster, renewing them
// transparently for OIDC sessions (via the refresh token) when they expire.
func (s *Server) credentials(r *http.Request, cluster string, force bool) (*session.Credentials, error) {
	st := stateFrom(r)
	if st == nil {
		return nil, catalog.ErrReauthenticate
	}
	st.mu.Lock()
	cur := st.s.Creds[cluster]
	st.mu.Unlock()
	if !force && cur.Valid(time.Now(), credentialSkew) {
		return cur, nil
	}
	if st.s.User.Method != "oidc" || s.oidc == nil {
		if msg, bad := st.s.ClusterErrors[cluster]; bad && cur == nil {
			return nil, fmt.Errorf("%w: %s", catalog.ErrClusterUnavailable, msg)
		}
		// The password is never kept, so the user must confirm it again.
		return nil, catalog.ErrCredentialsExpired
	}

	lk := s.lockFor(st.id + "|" + cluster)
	lk.Lock()
	defer lk.Unlock()
	// Another request may have renewed them while we waited; re-read from the store.
	if fresh, err := s.sessions.Load(r.Context(), st.id); err == nil {
		st.mu.Lock()
		st.s = fresh
		cur = fresh.Creds[cluster]
		st.mu.Unlock()
		if !force && cur.Valid(time.Now(), credentialSkew) {
			return cur, nil
		}
	}
	client := s.clients[cluster]
	ctx := r.Context()

	st.mu.Lock()
	tokens := *st.s.OIDC
	st.mu.Unlock()
	if time.Now().Add(credentialSkew).After(tokens.Expiry) || force {
		id, err := s.oidc.Refresh(ctx, &tokens)
		if err != nil {
			s.log.Info("oidc refresh failed", "err", err, "requestId", requestID(r))
			return nil, catalog.ErrReauthenticate
		}
		if id.User.Subject != st.s.User.Subject {
			return nil, catalog.ErrReauthenticate
		}
		tokens = id.Tokens
	}
	creds, err := client.AssumeRoleWithWebIdentity(ctx, s.oidc.STSToken(&tokens))
	if err != nil {
		if aistor.IsAuthFailure(err) {
			return nil, catalog.ErrReauthenticate
		}
		return nil, err
	}
	st.mu.Lock()
	st.s.OIDC = &tokens
	if st.s.Creds == nil {
		st.s.Creds = map[string]*session.Credentials{}
	}
	st.s.Creds[cluster] = creds
	delete(st.s.ClusterErrors, cluster)
	err = s.sessions.Save(ctx, st.id, st.s)
	st.mu.Unlock()
	if err != nil {
		s.log.Warn("session save after refresh failed", "err", err)
	}
	return creds, nil
}

func (s *Server) stepUpSatisfied(r *http.Request) bool {
	st := stateFrom(r)
	return st != nil && !st.s.StepUpAt.IsZero() && time.Since(st.s.StepUpAt) <= s.cfg.Session.StepUpValidFor
}

// ---------------------------------------------------------------- audit

func (s *Server) actor(r *http.Request) audit.Actor {
	if st := stateFrom(r); st != nil {
		return audit.Actor{Subject: st.s.User.Subject, Username: st.s.User.Username, Method: st.s.User.Method}
	}
	return audit.Actor{}
}

// editorName identifies the caller on saved semantic model versions.
func (s *Server) editorName(r *http.Request) string {
	if st := stateFrom(r); st != nil {
		return st.s.User.Username
	}
	return ""
}

func (s *Server) recordCatalog(r *http.Request, ev catalog.AuditEvent) {
	s.audit.Record(r.Context(), &audit.Record{RequestID: requestID(r), Kind: "catalog", Actor: s.actor(r), ClientIP: clientIP(r), AuditEvent: ev})
}

func (s *Server) recordAuth(r *http.Request, actor audit.Actor, op, outcome, errMsg string) {
	status := http.StatusOK
	if outcome != "success" {
		status = http.StatusUnauthorized
	}
	s.audit.Record(r.Context(), &audit.Record{RequestID: requestID(r), Kind: "auth", Actor: actor, ClientIP: clientIP(r),
		AuditEvent: catalog.AuditEvent{Operation: op, Outcome: outcome, Status: status, Error: errMsg}})
}

func (s *Server) handleActivity(w http.ResponseWriter, r *http.Request) {
	st := stateFrom(r)
	q := r.URL.Query()
	limit := 100
	if v, err := strconv.Atoi(q.Get("limit")); err == nil && v > 0 && v <= 500 {
		limit = v
	}
	offset := 0
	if v, err := strconv.Atoi(q.Get("offset")); err == nil && v >= 0 {
		offset = v
	}
	subject := st.s.User.Subject
	if q.Get("scope") == "all" {
		if !st.s.User.Admin {
			apierr.Write(w, http.StatusForbidden, "AccessDenied", "only administrators can view everyone's activity")
			return
		}
		subject = ""
	}
	var since, until time.Time
	for k, dst := range map[string]*time.Time{"since": &since, "until": &until} {
		if v := q.Get(k); v != "" {
			t, err := time.Parse(time.RFC3339, v)
			if err != nil {
				apierr.Write(w, http.StatusBadRequest, "ValidationError", k+" must be an RFC 3339 timestamp")
				return
			}
			*dst = t
		}
	}
	kind, outcome, text := q.Get("kind"), q.Get("outcome"), strings.ToLower(strings.TrimSpace(q.Get("q")))
	if len(text) > 200 {
		apierr.Write(w, http.StatusBadRequest, "ValidationError", "q is too long")
		return
	}
	// The store keeps a bounded window (audit.retain); filter it, newest first.
	recs, err := s.audit.List(r.Context(), subject, s.cfg.Audit.Retain)
	if err != nil {
		apierr.Write(w, http.StatusServiceUnavailable, "AuditUnavailable", "activity is temporarily unavailable")
		return
	}
	filtered := make([]audit.Record, 0, len(recs))
	for _, rec := range recs {
		if (!since.IsZero() && rec.Time.Before(since)) || (!until.IsZero() && rec.Time.After(until)) ||
			(kind != "" && rec.Kind != kind) || (outcome != "" && rec.Outcome != outcome) {
			continue
		}
		if text != "" && !strings.Contains(strings.ToLower(strings.Join([]string{rec.Operation, rec.Resource, rec.Actor.Username, rec.Action, rec.Error, rec.ClientIP}, " ")), text) {
			continue
		}
		filtered = append(filtered, rec)
	}
	total := len(filtered)
	if offset > total {
		offset = total
	}
	end := min(offset+limit, total)
	writeJSON(w, http.StatusOK, map[string]any{"records": filtered[offset:end], "total": total, "offset": offset, "retained": s.cfg.Audit.Retain})
}

func isAdmin(cfg *config.Config, u *session.User) bool {
	if slices.Contains(cfg.Auth.AdminUsers, u.Username) {
		return true
	}
	for _, g := range u.Groups {
		if slices.Contains(cfg.Auth.AdminGroups, g) {
			return true
		}
	}
	return false
}

var errNoCluster = errors.New("no cluster accepted the credentials")
