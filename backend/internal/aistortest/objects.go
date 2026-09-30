package aistortest

import (
	"bytes"
	"crypto/md5"
	"encoding/hex"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ObjectStore is a minimal versioned S3 object store: path-style GET, HEAD,
// PUT (with If-Match / If-None-Match), DELETE, ListObjectsV2 and
// ListObjectVersions, enough for semantic model storage.
type ObjectStore struct {
	mu      sync.Mutex
	buckets map[string]*bucket
	seq     int
}

type bucket struct {
	versioned bool
	objects   map[string][]*objVersion // history, oldest first
}

type objVersion struct {
	id       string
	body     []byte
	etag     string
	modified time.Time
	meta     http.Header
	marker   bool // delete marker
}

func NewObjectStore() *ObjectStore { return &ObjectStore{buckets: map[string]*bucket{}} }

// CreateBucket adds a bucket (versioned keeps every version).
func (s *ObjectStore) CreateBucket(name string, versioned bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.buckets[name] = &bucket{versioned: versioned, objects: map[string][]*objVersion{}}
}

// Put stores an object directly (test setup).
func (s *ObjectStore) Put(bucketName, key string, body []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.put(s.buckets[bucketName], key, body, nil)
}

// Keys lists the latest non-deleted keys of a bucket.
func (s *ObjectStore) Keys(bucketName string) []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []string
	for k, vs := range s.buckets[bucketName].objects {
		if !vs[len(vs)-1].marker {
			out = append(out, k)
		}
	}
	sort.Strings(out)
	return out
}

func (s *ObjectStore) put(b *bucket, key string, body []byte, meta http.Header) *objVersion {
	s.seq++
	sum := md5.Sum(body)
	v := &objVersion{id: fmt.Sprintf("v%06d", s.seq), body: append([]byte(nil), body...), etag: hex.EncodeToString(sum[:]), modified: time.Now().UTC().Add(time.Duration(s.seq) * time.Millisecond), meta: meta}
	if !b.versioned {
		v.id = "null"
		b.objects[key] = []*objVersion{v}
	} else {
		b.objects[key] = append(b.objects[key], v)
	}
	return v
}

func s3Error(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set("Content-Type", "application/xml")
	w.WriteHeader(status)
	fmt.Fprintf(w, `<?xml version="1.0" encoding="UTF-8"?><Error><Code>%s</Code><Message>%s</Message></Error>`, code, msg)
}

func (f *Fake) serveObjects(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	r.Body = io.NopCloser(bytes.NewReader(body))
	var user string
	ak, ok := f.verify(r, body, "s3", func(ak string) (string, string, bool) {
		f.mu.Lock()
		defer f.mu.Unlock()
		sess, ok := f.sessions[ak]
		if !ok {
			return "", "", false
		}
		user = sess.user
		return sess.secret, sess.token, true
	})
	if !ok {
		s3Error(w, http.StatusForbidden, "SignatureDoesNotMatch", "The request signature we calculated does not match")
		return
	}
	f.mu.Lock()
	if f.ExpireNext {
		f.ExpireNext = false
		delete(f.sessions, ak)
		f.mu.Unlock()
		s3Error(w, http.StatusForbidden, "ExpiredToken", "The provided token has expired")
		return
	}
	u := f.users[user]
	f.ObjectRequests = append(f.ObjectRequests, Recorded{User: user, Method: r.Method, RawPath: r.URL.EscapedPath(), Query: r.URL.Query(), Header: r.Header.Clone(), Body: string(body)})
	f.mu.Unlock()

	path := strings.TrimPrefix(r.URL.Path, "/")
	bucketName, key, _ := strings.Cut(path, "/")
	q := r.URL.Query()
	method := r.Method
	if method == http.MethodHead {
		method = http.MethodGet
	}
	// Permission: METHOD s3://bucket/key (listings use the prefix).
	target := key
	if key == "" {
		target = q.Get("prefix")
	}
	if !allowed(u, method+" s3://"+bucketName+"/"+target) {
		s3Error(w, http.StatusForbidden, "AccessDenied", "Access Denied.")
		return
	}
	s := f.Objects
	s.mu.Lock()
	defer s.mu.Unlock()
	b := s.buckets[bucketName]
	if b == nil {
		s3Error(w, http.StatusNotFound, "NoSuchBucket", "The specified bucket does not exist")
		return
	}
	switch {
	case key == "" && r.Method == http.MethodGet && q.Has("versions"):
		s.listVersions(w, b, q)
	case key == "" && r.Method == http.MethodGet:
		s.list(w, b, q)
	case key != "" && (r.Method == http.MethodGet || r.Method == http.MethodHead):
		vs := b.objects[key]
		var v *objVersion
		if id := q.Get("versionId"); id != "" {
			for _, x := range vs {
				if x.id == id {
					v = x
				}
			}
		} else if len(vs) > 0 {
			v = vs[len(vs)-1]
		}
		if v == nil || v.marker {
			s3Error(w, http.StatusNotFound, "NoSuchKey", "The specified key does not exist.")
			return
		}
		for k, x := range v.meta {
			w.Header()[k] = x
		}
		w.Header().Set("ETag", `"`+v.etag+`"`)
		w.Header().Set("Last-Modified", v.modified.Format(http.TimeFormat))
		w.Header().Set("X-Amz-Version-Id", v.id)
		w.Header().Set("Content-Length", strconv.Itoa(len(v.body)))
		w.WriteHeader(http.StatusOK)
		if r.Method == http.MethodGet {
			_, _ = w.Write(v.body)
		}
	case key != "" && r.Method == http.MethodPut:
		vs := b.objects[key]
		var cur *objVersion
		if len(vs) > 0 && !vs[len(vs)-1].marker {
			cur = vs[len(vs)-1]
		}
		if im := r.Header.Get("If-Match"); im != "" && (cur == nil || strings.Trim(im, `"`) != cur.etag) {
			s3Error(w, http.StatusPreconditionFailed, "PreconditionFailed", "At least one of the pre-conditions you specified did not hold")
			return
		}
		if r.Header.Get("If-None-Match") == "*" && cur != nil {
			s3Error(w, http.StatusPreconditionFailed, "PreconditionFailed", "At least one of the pre-conditions you specified did not hold")
			return
		}
		meta := http.Header{}
		for k, x := range r.Header {
			if strings.HasPrefix(strings.ToLower(k), "x-amz-meta-") {
				meta[k] = x
			}
		}
		v := s.put(b, key, body, meta)
		w.Header().Set("ETag", `"`+v.etag+`"`)
		w.Header().Set("X-Amz-Version-Id", v.id)
		w.WriteHeader(http.StatusOK)
	case key != "" && r.Method == http.MethodDelete:
		if b.versioned {
			s.seq++
			b.objects[key] = append(b.objects[key], &objVersion{id: fmt.Sprintf("v%06d", s.seq), marker: true, modified: time.Now().UTC().Add(time.Duration(s.seq) * time.Millisecond)})
		} else {
			delete(b.objects, key)
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		s3Error(w, http.StatusNotImplemented, "NotImplemented", "not implemented by the test object store")
	}
}

func (s *ObjectStore) list(w http.ResponseWriter, b *bucket, q map[string][]string) {
	get := func(k string) string {
		if v := q[k]; len(v) > 0 {
			return v[0]
		}
		return ""
	}
	prefix, delim, after := get("prefix"), get("delimiter"), get("continuation-token")
	maxKeys, _ := strconv.Atoi(get("max-keys"))
	if maxKeys <= 0 || maxKeys > 1000 {
		maxKeys = 1000
	}
	var keys []string
	for k, vs := range b.objects {
		if strings.HasPrefix(k, prefix) && !vs[len(vs)-1].marker {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	type content struct {
		Key          string `xml:"Key"`
		LastModified string `xml:"LastModified"`
		ETag         string `xml:"ETag"`
		Size         int    `xml:"Size"`
	}
	type cp struct {
		Prefix string `xml:"Prefix"`
	}
	res := struct {
		XMLName               xml.Name  `xml:"ListBucketResult"`
		Prefix                string    `xml:"Prefix"`
		Contents              []content `xml:"Contents"`
		CommonPrefixes        []cp      `xml:"CommonPrefixes"`
		IsTruncated           bool      `xml:"IsTruncated"`
		NextContinuationToken string    `xml:"NextContinuationToken,omitempty"`
	}{Prefix: prefix}
	seen := map[string]bool{}
	n := 0
	for _, k := range keys {
		if after != "" && k <= after {
			continue
		}
		if n >= maxKeys {
			res.IsTruncated = true
			break
		}
		rest := strings.TrimPrefix(k, prefix)
		if delim != "" {
			if i := strings.Index(rest, delim); i >= 0 {
				p := prefix + rest[:i+len(delim)]
				if !seen[p] {
					seen[p] = true
					res.CommonPrefixes = append(res.CommonPrefixes, cp{p})
				}
				continue
			}
		}
		v := b.objects[k][len(b.objects[k])-1]
		res.Contents = append(res.Contents, content{Key: k, LastModified: v.modified.Format(time.RFC3339Nano), ETag: `"` + v.etag + `"`, Size: len(v.body)})
		res.NextContinuationToken = k
		n++
	}
	if !res.IsTruncated {
		res.NextContinuationToken = ""
	}
	w.Header().Set("Content-Type", "application/xml")
	_ = xml.NewEncoder(w).Encode(res)
}

func (s *ObjectStore) listVersions(w http.ResponseWriter, b *bucket, q map[string][]string) {
	prefix := ""
	if v := q["prefix"]; len(v) > 0 {
		prefix = v[0]
	}
	type version struct {
		XMLName      xml.Name
		Key          string `xml:"Key"`
		VersionID    string `xml:"VersionId"`
		IsLatest     bool   `xml:"IsLatest"`
		LastModified string `xml:"LastModified"`
		ETag         string `xml:"ETag,omitempty"`
		Size         int    `xml:"Size,omitempty"`
	}
	res := struct {
		XMLName xml.Name `xml:"ListVersionsResult"`
		Entries []version
	}{}
	var keys []string
	for k := range b.objects {
		if strings.HasPrefix(k, prefix) {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	for _, k := range keys {
		vs := b.objects[k]
		for i := len(vs) - 1; i >= 0; i-- {
			v := vs[i]
			e := version{Key: k, VersionID: v.id, IsLatest: i == len(vs)-1, LastModified: v.modified.Format(time.RFC3339Nano)}
			if v.marker {
				e.XMLName = xml.Name{Local: "DeleteMarker"}
			} else {
				e.XMLName = xml.Name{Local: "Version"}
				e.ETag, e.Size = `"`+v.etag+`"`, len(v.body)
			}
			res.Entries = append(res.Entries, e)
		}
	}
	w.Header().Set("Content-Type", "application/xml")
	_ = xml.NewEncoder(w).Encode(res)
}
