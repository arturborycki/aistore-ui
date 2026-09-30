package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/arturborycki/aistore-ui/backend/internal/apierr"
	"github.com/arturborycki/aistore-ui/backend/internal/auth"
	"github.com/arturborycki/aistore-ui/backend/internal/catalog"
	"github.com/arturborycki/aistore-ui/backend/internal/semantic"
	"github.com/arturborycki/aistore-ui/backend/internal/session"
)

// Serving semantic models to tools and agents: /ossie/v1 (REST, read-only)
// and /ossie/mcp (Model Context Protocol). Callers authenticate with a JWT
// bearer token from the configured OIDC provider; the server exchanges it
// for the caller's own AIStor credentials (AssumeRoleWithWebIdentity), so
// every read is authorized by AIStor exactly as for the UI. No cookies,
// no sessions and no API keys are involved.

type bearerKey struct{}

type bearerState struct {
	token string
	id    *auth.Bearer
}

func bearerFrom(r *http.Request) *bearerState {
	v, _ := r.Context().Value(bearerKey{}).(*bearerState)
	return v
}

// stsCache keeps exchanged credentials per token and cluster until they expire.
type stsCache struct {
	mu sync.Mutex
	m  map[string]*session.Credentials
}

func (c *stsCache) get(k string) *session.Credentials {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.m[k]
}

func (c *stsCache) put(k string, v *session.Credentials) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.m) > 2000 {
		now := time.Now()
		for key, x := range c.m {
			if !x.Valid(now, 0) {
				delete(c.m, key)
			}
		}
		if len(c.m) > 2000 {
			c.m = map[string]*session.Credentials{}
		}
	}
	c.m[k] = v
}

func (s *Server) resourceMetadataURL() string {
	return strings.TrimSuffix(s.cfg.PublicURL().String(), "/") + "/.well-known/oauth-protected-resource"
}

// bearerAuth authenticates /ossie requests.
func (s *Server) bearerAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// DNS-rebinding protection (required for MCP over HTTP): browsers
		// send Origin; only our own origins may call.
		if o := r.Header.Get("Origin"); o != "" && !s.checkOrigin(r) {
			apierr.Write(w, http.StatusForbidden, "OriginRejected", "cross-origin requests are not allowed")
			return
		}
		challenge := fmt.Sprintf(`Bearer realm="aistor-catalog", resource_metadata="%s"`, s.resourceMetadataURL())
		authz := r.Header.Get("Authorization")
		token, ok := strings.CutPrefix(authz, "Bearer ")
		if !ok || strings.TrimSpace(token) == "" {
			w.Header().Set("WWW-Authenticate", challenge)
			apierr.Write(w, http.StatusUnauthorized, "NotAuthenticated", "send an OIDC bearer token: Authorization: Bearer <token>")
			return
		}
		token = strings.TrimSpace(token)
		id, err := s.oidc.VerifyBearer(r.Context(), token, s.cfg.Semantic.Serving.Audiences)
		if err != nil {
			w.Header().Set("WWW-Authenticate", challenge+`, error="invalid_token"`)
			apierr.Write(w, http.StatusUnauthorized, "InvalidToken", "the bearer token is not valid for this server")
			return
		}
		if !s.bearerLimiter.allow(r.Context(), "bearer:"+id.Subject) {
			w.Header().Set("Retry-After", "10")
			apierr.Write(w, http.StatusTooManyRequests, "RateLimited", "too many requests; slow down")
			return
		}
		ctx := context.WithValue(r.Context(), bearerKey{}, &bearerState{token: token, id: id})
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// bearerCredentials exchanges the caller's token for AIStor credentials.
func (s *Server) bearerCredentials(r *http.Request, cluster string, force bool) (*session.Credentials, error) {
	b := bearerFrom(r)
	if b == nil {
		return nil, catalog.ErrReauthenticate
	}
	client, ok := s.clients[cluster]
	if !ok {
		return nil, catalog.ErrClusterUnavailable
	}
	sum := sha256.Sum256([]byte(b.token))
	key := hex.EncodeToString(sum[:]) + "|" + cluster
	if c := s.stsCache.get(key); c != nil && !force && c.Valid(time.Now(), credentialSkew) {
		return c, nil
	}
	creds, err := client.AssumeRoleWithWebIdentity(r.Context(), b.token)
	if err != nil {
		return nil, err
	}
	s.stsCache.put(key, creds)
	return creds, nil
}

func (s *Server) mountOssie(r chi.Router) {
	api := semantic.NewAPI(s.cfg.Semantic, &catalog.Deps{
		Clients:         s.clients,
		Credentials:     s.bearerCredentials,
		StepUpSatisfied: func(*http.Request) bool { return false },
		RequestID:       requestID,
		MaxBodyBytes:    s.cfg.Limits.MaxBodyBytes,
		Log:             s.log,
	}, func(r *http.Request) string {
		if b := bearerFrom(r); b != nil {
			return b.id.Username
		}
		return ""
	})
	r.Get("/.well-known/oauth-protected-resource", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"resource":                 strings.TrimSuffix(s.cfg.PublicURL().String(), "/") + "/ossie",
			"authorization_servers":    []string{s.cfg.Auth.OIDC.Issuer},
			"bearer_methods_supported": []string{"header"},
			"resource_name":            "AIStor Catalog semantic models (Apache Ossie)",
		})
	})
	r.Route("/ossie", func(r chi.Router) {
		r.Get("/v1/schema", semantic.ServeSchema)
		r.Group(func(r chi.Router) {
			r.Use(s.bearerAuth)
			api.MountServing(r)
			r.HandleFunc("/mcp", api.HandleMCP(s.version))
		})
	})
}
