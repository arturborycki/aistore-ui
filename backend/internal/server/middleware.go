package server

import (
	"context"
	"crypto/subtle"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"runtime/debug"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"golang.org/x/time/rate"

	"github.com/arturborycki/aistore-ui/backend/internal/apierr"
	"github.com/arturborycki/aistore-ui/backend/internal/session"
)

type ctxKey int

const (
	ctxRequestID ctxKey = iota
	ctxSession
	ctxClientIP
)

// reqState is attached to each request that carries a valid session.
type reqState struct {
	id string
	s  *session.Session
	mu sync.Mutex // guards s during credential refresh
}

func requestID(r *http.Request) string {
	v, _ := r.Context().Value(ctxRequestID).(string)
	return v
}

func clientIP(r *http.Request) string {
	v, _ := r.Context().Value(ctxClientIP).(string)
	return v
}

func stateFrom(r *http.Request) *reqState {
	v, _ := r.Context().Value(ctxSession).(*reqState)
	return v
}

// withRequestMeta assigns a request ID and resolves the client IP.
func (s *Server) withRequestMeta(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := session.NewID()[:22]
		ip, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil {
			ip = r.RemoteAddr
		}
		if s.cfg.Server.TrustProxy {
			if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
				ip = strings.TrimSpace(strings.Split(xff, ",")[0])
			}
		}
		ctx := context.WithValue(r.Context(), ctxRequestID, id)
		ctx = context.WithValue(ctx, ctxClientIP, ip)
		w.Header().Set("X-Request-Id", id)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

const contentSecurityPolicy = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; " +
	"connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; worker-src 'self' blob:; upgrade-insecure-requests"

func (s *Server) securityHeaders(next http.Handler) http.Handler {
	hsts := s.cfg.PublicURL().Scheme == "https"
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		csp := contentSecurityPolicy
		if !hsts {
			csp = strings.TrimSuffix(csp, "; upgrade-insecure-requests")
		}
		h.Set("Content-Security-Policy", csp)
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		h.Set("Cross-Origin-Resource-Policy", "same-origin")
		h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()")
		if hsts {
			h.Set("Strict-Transport-Security", "max-age=63072000; includeSubDomains")
		}
		next.ServeHTTP(w, r)
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
	bytes  int64
}

func (w *statusRecorder) WriteHeader(code int) {
	if w.status == 0 {
		w.status = code
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusRecorder) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	n, err := w.ResponseWriter.Write(b)
	w.bytes += int64(n)
	return n, err
}

func (w *statusRecorder) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// accessLog logs each request (never headers, cookies or bodies) and records metrics.
func (s *Server) accessLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w}
		defer func() {
			if p := recover(); p != nil {
				s.log.Error("panic", "requestId", requestID(r), "panic", p, "stack", string(debug.Stack()))
				if rec.status == 0 {
					apierr.Write(rec, http.StatusInternalServerError, "InternalError", "internal error")
				}
			}
			route := chi.RouteContext(r.Context()).RoutePattern()
			if route == "" {
				route = "unmatched"
			}
			d := time.Since(start)
			s.metrics.observe(r.Method, route, rec.status, d)
			if strings.HasPrefix(r.URL.Path, "/assets/") {
				return
			}
			user := ""
			if st := stateFrom(r); st != nil {
				user = st.s.User.Username
			}
			s.log.LogAttrs(r.Context(), slog.LevelInfo, "http",
				slog.String("requestId", requestID(r)), slog.String("method", r.Method), slog.String("route", route),
				slog.Int("status", rec.status), slog.Int64("bytes", rec.bytes), slog.Duration("duration", d),
				slog.String("user", user), slog.String("clientIp", clientIP(r)))
		}()
		next.ServeHTTP(rec, r)
	})
}

// loadSession attaches the session (if any) to the request context.
func (s *Server) loadSession(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie(s.cfg.CookieName())
		if err != nil || c.Value == "" {
			next.ServeHTTP(w, r)
			return
		}
		sess, err := s.sessions.Load(r.Context(), c.Value)
		if err != nil {
			if !errors.Is(err, session.ErrNotFound) {
				s.log.Error("session load failed", "err", err, "requestId", requestID(r))
				apierr.Write(w, http.StatusServiceUnavailable, "SessionStoreUnavailable", "session store unavailable")
				return
			}
			s.clearSessionCookie(w)
			next.ServeHTTP(w, r)
			return
		}
		if err := s.sessions.Touch(r.Context(), c.Value, sess); err != nil {
			s.log.Warn("session touch failed", "err", err)
		}
		ctx := context.WithValue(r.Context(), ctxSession, &reqState{id: c.Value, s: sess})
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func (s *Server) requireSession(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if stateFrom(r) == nil {
			apierr.Write(w, http.StatusUnauthorized, "NotAuthenticated", "sign in required")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func safeMethod(m string) bool {
	return m == http.MethodGet || m == http.MethodHead || m == http.MethodOptions
}

// checkOrigin rejects cross-site state-changing requests (defence in depth on
// top of SameSite=Strict cookies and the CSRF token).
func (s *Server) checkOrigin(r *http.Request) bool {
	if site := r.Header.Get("Sec-Fetch-Site"); site != "" && site != "same-origin" && site != "none" {
		return false
	}
	origin := r.Header.Get("Origin")
	if origin == "" {
		// Browsers always send Origin on non-GET fetches; its absence means a
		// non-browser client, which still has to present the CSRF token.
		return true
	}
	for _, o := range s.cfg.AllowedOrigins() {
		if strings.EqualFold(o, origin) {
			return true
		}
	}
	return false
}

// csrf enforces origin checks and, for authenticated requests, the
// synchronizer token on every state-changing method.
func (s *Server) csrf(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if safeMethod(r.Method) {
			next.ServeHTTP(w, r)
			return
		}
		if !s.checkOrigin(r) {
			apierr.Write(w, http.StatusForbidden, "CSRFRejected", "cross-site request rejected")
			return
		}
		if st := stateFrom(r); st != nil {
			tok := r.Header.Get("X-CSRF-Token")
			if tok == "" || subtle.ConstantTimeCompare([]byte(tok), []byte(st.s.CSRFToken)) != 1 {
				apierr.Write(w, http.StatusForbidden, "CSRFRejected", "missing or invalid CSRF token")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// limiter is a keyed token-bucket rate limiter with idle eviction.
type limiter struct {
	mu      sync.Mutex
	perMin  int
	buckets map[string]*bucket
}

type bucket struct {
	l    *rate.Limiter
	seen time.Time
}

func newLimiter(perMinute int) *limiter {
	l := &limiter{perMin: perMinute, buckets: map[string]*bucket{}}
	go func() {
		for range time.Tick(5 * time.Minute) {
			l.mu.Lock()
			for k, b := range l.buckets {
				if time.Since(b.seen) > 10*time.Minute {
					delete(l.buckets, k)
				}
			}
			l.mu.Unlock()
		}
	}()
	return l
}

func (l *limiter) allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	b, ok := l.buckets[key]
	if !ok {
		burst := l.perMin / 4
		if burst < 5 {
			burst = 5
		}
		b = &bucket{l: rate.NewLimiter(rate.Limit(float64(l.perMin)/60), burst)}
		l.buckets[key] = b
	}
	b.seen = time.Now()
	return b.l.Allow()
}

func (s *Server) rateLimit(l *limiter, byIP bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			key := "ip:" + clientIP(r)
			if st := stateFrom(r); st != nil && !byIP {
				key = "sess:" + st.id
			}
			if !l.allow(key) {
				w.Header().Set("Retry-After", "10")
				apierr.Write(w, http.StatusTooManyRequests, "RateLimited", "too many requests; slow down")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
