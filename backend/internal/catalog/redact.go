package catalog

import (
	"encoding/json"
	"regexp"
	"strings"
)

var sensitiveKey = regexp.MustCompile(`(?i)(secret|token|credential|password|passwd|session|signature|private|access[-_.]?key)`)

// harmlessS3Keys are s3.* config keys that carry no secret and are useful to show.
var harmlessS3Keys = map[string]bool{
	"s3.delete-enabled":     true,
	"s3.path-style-access":  true,
	"s3.region":             true,
	"s3.sse.type":           true,
	"s3.write.tags.enabled": true,
}

func sensitive(k string) bool {
	if sensitiveKey.MatchString(k) {
		return true
	}
	lk := strings.ToLower(k)
	if strings.HasPrefix(lk, "s3.") || strings.HasPrefix(lk, "client.") || strings.HasPrefix(lk, "adls.") || strings.HasPrefix(lk, "gcs.") {
		return !harmlessS3Keys[lk]
	}
	return false
}

func redactMap(raw json.RawMessage) (json.RawMessage, bool) {
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, true // unparsable config maps are dropped entirely
	}
	changed := false
	for k := range m {
		if sensitive(k) {
			delete(m, k)
			changed = true
		}
	}
	if !changed {
		return raw, false
	}
	out, _ := json.Marshal(m)
	return out, true
}

// Redact removes storage credentials from Iceberg LoadTable / LoadView /
// GetConfig shaped JSON documents. Every other field is preserved byte-for-byte
// (in particular 64-bit snapshot IDs are never round-tripped through float64).
func Redact(body []byte) []byte {
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(body, &doc); err != nil {
		return body
	}
	changed := false
	if _, ok := doc["storage-credentials"]; ok {
		delete(doc, "storage-credentials")
		changed = true
	}
	for _, k := range []string{"config", "defaults", "overrides"} {
		v, ok := doc[k]
		if !ok || string(v) == "null" {
			continue
		}
		nv, ch := redactMap(v)
		if ch {
			changed = true
			if nv == nil {
				delete(doc, k)
			} else {
				doc[k] = nv
			}
		}
	}
	if !changed {
		return body
	}
	out, err := json.Marshal(doc)
	if err != nil {
		return body
	}
	return out
}
