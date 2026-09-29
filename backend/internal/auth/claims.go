package auth

import (
	"net/url"
	"strings"
)

func queryEscape(s string) string { return url.QueryEscape(s) }

func firstNonEmpty(v ...string) string {
	for _, s := range v {
		if s != "" {
			return s
		}
	}
	return ""
}

// lookup resolves a dotted claim path such as "realm_access.roles".
func lookup(all map[string]any, path string) any {
	var cur any = all
	for _, part := range strings.Split(path, ".") {
		m, ok := cur.(map[string]any)
		if !ok {
			return nil
		}
		cur = m[part]
	}
	return cur
}

func stringClaim(all map[string]any, path string) string {
	s, _ := lookup(all, path).(string)
	return s
}

func listClaim(all map[string]any, path string) []string {
	switch v := lookup(all, path).(type) {
	case string:
		out := []string{}
		for _, s := range strings.Split(v, ",") {
			if s = strings.TrimSpace(s); s != "" {
				out = append(out, s)
			}
		}
		return out
	case []any:
		out := make([]string, 0, len(v))
		for _, x := range v {
			if s, ok := x.(string); ok {
				out = append(out, s)
			}
		}
		return out
	}
	return nil
}
