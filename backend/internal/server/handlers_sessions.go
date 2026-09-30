package server

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/arturborycki/aistore-ui/backend/internal/apierr"
	"github.com/arturborycki/aistore-ui/backend/internal/audit"
	"github.com/arturborycki/aistore-ui/backend/internal/catalog"
	"github.com/arturborycki/aistore-ui/backend/internal/session"
)

// Session management: users see and revoke their own sessions; administrators
// see and revoke everyone's. Sessions are addressed by a public handle, never
// by the secret session ID.

func (s *Server) mountSessions(r chi.Router) {
	r.Get("/sessions", s.handleListSessions)
	r.Delete("/sessions/{handle}", s.handleRevokeSession)
	r.Post("/sessions/revoke-others", s.handleRevokeOthers)
	r.Get("/admin/sessions", s.handleAdminListSessions)
	r.Delete("/admin/sessions", s.handleAdminRevoke)
}

func (s *Server) recordSession(r *http.Request, op, target, outcome string) {
	s.audit.Record(r.Context(), &audit.Record{RequestID: requestID(r), Kind: "auth", Actor: s.actor(r), ClientIP: clientIP(r),
		AuditEvent: catalog.AuditEvent{Operation: op, Resource: target, Outcome: outcome, Status: http.StatusOK}})
}

func (s *Server) handleListSessions(w http.ResponseWriter, r *http.Request) {
	st := stateFrom(r)
	list, err := s.sessions.List(r.Context(), st.s.User.Subject, st.s.Handle)
	if err != nil {
		apierr.Write(w, http.StatusServiceUnavailable, "SessionStoreUnavailable", "sessions are temporarily unavailable")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"sessions": list})
}

func (s *Server) handleRevokeSession(w http.ResponseWriter, r *http.Request) {
	st := stateFrom(r)
	handle := chi.URLParam(r, "handle")
	if len(handle) == 0 || len(handle) > 64 {
		apierr.Write(w, http.StatusBadRequest, "ValidationError", "invalid session handle")
		return
	}
	if err := s.sessions.Revoke(r.Context(), st.s.User.Subject, handle); err != nil {
		if errors.Is(err, session.ErrNotFound) {
			apierr.Write(w, http.StatusNotFound, "NotFound", "no such session")
			return
		}
		apierr.Write(w, http.StatusServiceUnavailable, "SessionStoreUnavailable", "could not revoke the session")
		return
	}
	if handle == st.s.Handle {
		s.clearSessionCookie(w)
	}
	s.recordSession(r, "RevokeSession", st.s.User.Username+"/"+handle, "success")
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleRevokeOthers(w http.ResponseWriter, r *http.Request) {
	st := stateFrom(r)
	list, err := s.sessions.List(r.Context(), st.s.User.Subject, st.s.Handle)
	if err != nil {
		apierr.Write(w, http.StatusServiceUnavailable, "SessionStoreUnavailable", "sessions are temporarily unavailable")
		return
	}
	n := 0
	for _, info := range list {
		if info.Current {
			continue
		}
		if s.sessions.Revoke(r.Context(), st.s.User.Subject, info.Handle) == nil {
			n++
		}
	}
	s.recordSession(r, "RevokeOtherSessions", st.s.User.Username, "success")
	writeJSON(w, http.StatusOK, map[string]any{"revoked": n})
}

func (s *Server) handleAdminListSessions(w http.ResponseWriter, r *http.Request) {
	st := stateFrom(r)
	if !st.s.User.Admin {
		apierr.Write(w, http.StatusForbidden, "AccessDenied", "only administrators can list all sessions")
		return
	}
	list, err := s.sessions.ListAll(r.Context(), st.s.Handle)
	if err != nil {
		apierr.Write(w, http.StatusServiceUnavailable, "SessionStoreUnavailable", "sessions are temporarily unavailable")
		return
	}
	if list == nil {
		list = []session.Info{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"sessions": list})
}

func (s *Server) handleAdminRevoke(w http.ResponseWriter, r *http.Request) {
	st := stateFrom(r)
	if !st.s.User.Admin {
		apierr.Write(w, http.StatusForbidden, "AccessDenied", "only administrators can revoke other users' sessions")
		return
	}
	sub, handle := r.URL.Query().Get("sub"), r.URL.Query().Get("handle")
	if sub == "" || handle == "" || len(sub) > 512 || len(handle) > 64 {
		apierr.Write(w, http.StatusBadRequest, "ValidationError", "sub and handle are required")
		return
	}
	if err := s.sessions.Revoke(r.Context(), sub, handle); err != nil {
		if errors.Is(err, session.ErrNotFound) {
			apierr.Write(w, http.StatusNotFound, "NotFound", "no such session")
			return
		}
		apierr.Write(w, http.StatusServiceUnavailable, "SessionStoreUnavailable", "could not revoke the session")
		return
	}
	s.recordSession(r, "AdminRevokeSession", sub+"/"+handle, "success")
	w.WriteHeader(http.StatusNoContent)
}
