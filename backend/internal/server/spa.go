package server

import (
	"io/fs"
	"net/http"
	"path"
	"strings"
)

// spaHandler serves the embedded single-page app. Hashed assets are cached
// forever; every other path falls back to index.html (client-side routing),
// which is never cached so deployments take effect immediately.
func (s *Server) spaHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if s.static == nil {
			http.Error(w, "UI not built", http.StatusNotFound)
			return
		}
		p := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
		if p != "" && p != "index.html" {
			if f, err := fs.Stat(s.static, p); err == nil && !f.IsDir() {
				if strings.HasPrefix(p, "assets/") {
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				} else {
					w.Header().Set("Cache-Control", "no-cache")
				}
				http.ServeFileFS(w, r, s.static, p)
				return
			}
			if strings.HasPrefix(p, "assets/") || path.Ext(p) != "" {
				http.NotFound(w, r)
				return
			}
		}
		idx, err := fs.ReadFile(s.static, "index.html")
		if err != nil {
			http.Error(w, "UI not built", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(idx)
	})
}
