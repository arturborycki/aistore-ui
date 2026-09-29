// Package apierr writes errors in the Iceberg REST ErrorModel shape, so the
// browser handles server-side and catalog errors uniformly:
//
//	{"error": {"message": "...", "type": "...", "code": 403}}
package apierr

import (
	"encoding/json"
	"net/http"
)

func Body(status int, typ, msg string) []byte {
	b, _ := json.Marshal(map[string]any{"error": map[string]any{"message": msg, "type": typ, "code": status}})
	return b
}

func Write(w http.ResponseWriter, status int, typ, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write(Body(status, typ, msg))
}
