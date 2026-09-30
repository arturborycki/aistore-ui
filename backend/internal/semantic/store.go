package semantic

import (
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/arturborycki/aistore-ui/backend/internal/aistor"
	"github.com/arturborycki/aistore-ui/backend/internal/catalog"
	"github.com/arturborycki/aistore-ui/backend/internal/session"
)

// FileSuffix ends every model object key.
const FileSuffix = ".ossie.yaml"

// EditorMeta is the object metadata recording who saved a version (as told
// by this UI; direct S3 writers can set anything).
const EditorMeta = "X-Amz-Meta-Aistor-Ui-Editor"

var modelNameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)

// ValidModelName checks a model (file) name.
func ValidModelName(s string) error {
	if !modelNameRe.MatchString(s) {
		return fmt.Errorf("model names use letters, digits, _ and - (at most 128), starting with a letter or digit")
	}
	return nil
}

// Key is the object key of a model: <warehouse>/<ns…>/<model>.ossie.yaml.
func Key(wh string, ns []string, model string) string {
	return NamespacePrefix(wh, ns) + model + FileSuffix
}

// NamespacePrefix is the key prefix holding a namespace's models.
func NamespacePrefix(wh string, ns []string) string {
	return wh + "/" + strings.Join(ns, "/") + "/"
}

// ParseKey splits a model key back into warehouse, namespace and model name.
func ParseKey(key string) (wh string, ns []string, model string, ok bool) {
	if !strings.HasSuffix(key, FileSuffix) {
		return "", nil, "", false
	}
	parts := strings.Split(strings.TrimSuffix(key, FileSuffix), "/")
	if len(parts) < 3 {
		return "", nil, "", false
	}
	model = parts[len(parts)-1]
	if ValidModelName(model) != nil || catalog.ValidWarehouse(parts[0]) != nil {
		return "", nil, "", false
	}
	levels, err := catalog.ValidNamespaceLevels(parts[1 : len(parts)-1])
	if err != nil {
		return "", nil, "", false
	}
	return parts[0], levels, model, true
}

// StoreError is an object-store failure mapped for the API.
type StoreError struct {
	Status   int
	Type     string
	Message  string
	Action   string // s3 action, for "you need permission X"
	Resource string // ARN
}

func (e *StoreError) Error() string { return e.Message }

// Store reads and writes model objects with the caller's own credentials.
type Store struct {
	Bucket string
	Deps   *catalog.Deps
}

// Object is a fetched model object.
type Object struct {
	Body         []byte
	ETag         string
	VersionID    string
	LastModified time.Time
	Editor       string
}

func (s *Store) arn(key string) string { return "arn:aws:s3:::" + s.Bucket + "/" + key }

func (s *Store) do(req *http.Request, cluster string, client *aistor.Client, or *aistor.ObjectRequest) (*http.Response, error) {
	or.Bucket = s.Bucket
	or.RequestID = s.Deps.RequestID(req)
	return s.Deps.Upstream(req, cluster, func(c *session.Credentials) (*http.Response, error) {
		return client.DoObject(req.Context(), c, or)
	})
}

type s3Err struct {
	Code    string `xml:"Code"`
	Message string `xml:"Message"`
}

func (s *Store) fail(resp *http.Response, action, key string) error {
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	var e s3Err
	_ = xml.Unmarshal(raw, &e)
	se := &StoreError{Status: resp.StatusCode, Type: "UpstreamError", Message: e.Message, Action: action, Resource: s.arn(key)}
	switch {
	case e.Code == "NoSuchBucket":
		se.Status, se.Type = http.StatusServiceUnavailable, "SemanticStoreUnavailable"
		se.Message = fmt.Sprintf("the semantic model bucket %q does not exist; ask an administrator to create it", s.Bucket)
	case resp.StatusCode == http.StatusNotFound:
		se.Status, se.Type, se.Message = http.StatusNotFound, "NoSuchModel", "the semantic model does not exist"
	case resp.StatusCode == http.StatusPreconditionFailed || e.Code == "PreconditionFailed" || resp.StatusCode == http.StatusConflict:
		se.Status, se.Type = http.StatusConflict, "ModelConflict"
		se.Message = "the model was changed by someone else since you opened it; reload it and apply your changes again"
	case resp.StatusCode == http.StatusForbidden:
		se.Type = "AccessDenied"
		se.Message = fmt.Sprintf("AIStor denied %s on %s", action, s.arn(key))
	case se.Message == "":
		se.Message = fmt.Sprintf("the object store answered HTTP %d", resp.StatusCode)
	}
	return se
}

func unquote(etag string) string { return strings.Trim(etag, `"`) }

// Get fetches a model object (the latest, or a given version).
func (s *Store) Get(req *http.Request, cluster string, client *aistor.Client, key, versionID string, maxBytes int) (*Object, error) {
	q := url.Values{}
	if versionID != "" {
		q.Set("versionId", versionID)
	}
	resp, err := s.do(req, cluster, client, &aistor.ObjectRequest{Method: http.MethodGet, Key: key, Query: q})
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, s.fail(resp, "s3:GetObject", key)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, int64(maxBytes)+1))
	if err != nil {
		return nil, err
	}
	if len(body) > maxBytes {
		return nil, &StoreError{Status: http.StatusBadGateway, Type: "ModelTooLarge", Message: "the stored model is larger than the configured limit"}
	}
	lm, _ := http.ParseTime(resp.Header.Get("Last-Modified"))
	return &Object{Body: body, ETag: unquote(resp.Header.Get("ETag")), VersionID: resp.Header.Get("X-Amz-Version-Id"), LastModified: lm, Editor: resp.Header.Get(EditorMeta)}, nil
}

// Put writes a model. ifMatch guards updates; create (ifMatch == "") only
// succeeds when the key does not exist yet.
func (s *Store) Put(req *http.Request, cluster string, client *aistor.Client, key string, body []byte, ifMatch, editor string) (etag, versionID string, err error) {
	h := http.Header{}
	h.Set("Content-Type", "application/yaml")
	h.Set(EditorMeta, editor)
	if ifMatch == "" {
		h.Set("If-None-Match", "*")
	} else {
		h.Set("If-Match", `"`+unquote(ifMatch)+`"`)
	}
	resp, err := s.do(req, cluster, client, &aistor.ObjectRequest{Method: http.MethodPut, Key: key, Header: h, Body: body})
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", "", s.fail(resp, "s3:PutObject", key)
	}
	return unquote(resp.Header.Get("ETag")), resp.Header.Get("X-Amz-Version-Id"), nil
}

// Delete removes a model if it still has the given ETag.
func (s *Store) Delete(req *http.Request, cluster string, client *aistor.Client, key, ifMatch string) error {
	// Check the version first so a concurrent edit is not deleted blindly
	// (conditional DELETE is not universally supported).
	cur, err := s.Get(req, cluster, client, key, "", 16<<20)
	if err != nil {
		return err
	}
	if unquote(ifMatch) != cur.ETag {
		return &StoreError{Status: http.StatusConflict, Type: "ModelConflict", Message: "the model was changed by someone else since you opened it"}
	}
	resp, err := s.do(req, cluster, client, &aistor.ObjectRequest{Method: http.MethodDelete, Key: key})
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusOK {
		return s.fail(resp, "s3:DeleteObject", key)
	}
	return nil
}

// Listed is an entry of a listing.
type Listed struct {
	Key          string
	ETag         string
	Size         int64
	LastModified time.Time
}

type listResult struct {
	Contents []struct {
		Key          string `xml:"Key"`
		ETag         string `xml:"ETag"`
		Size         int64  `xml:"Size"`
		LastModified string `xml:"LastModified"`
	} `xml:"Contents"`
	CommonPrefixes []struct {
		Prefix string `xml:"Prefix"`
	} `xml:"CommonPrefixes"`
	IsTruncated           bool   `xml:"IsTruncated"`
	NextContinuationToken string `xml:"NextContinuationToken"`
}

// List returns model objects under prefix (only direct children when
// delimited), up to max entries.
func (s *Store) List(req *http.Request, cluster string, client *aistor.Client, prefix string, delimited bool, max int) ([]Listed, bool, error) {
	var out []Listed
	token := ""
	for {
		q := url.Values{"list-type": {"2"}, "prefix": {prefix}, "max-keys": {"1000"}}
		if delimited {
			q.Set("delimiter", "/")
		}
		if token != "" {
			q.Set("continuation-token", token)
		}
		resp, err := s.do(req, cluster, client, &aistor.ObjectRequest{Method: http.MethodGet, Query: q})
		if err != nil {
			return nil, false, err
		}
		if resp.StatusCode != http.StatusOK {
			err := s.fail(resp, "s3:ListBucket", prefix)
			resp.Body.Close()
			return nil, false, err
		}
		var lr listResult
		err = xml.NewDecoder(io.LimitReader(resp.Body, 16<<20)).Decode(&lr)
		resp.Body.Close()
		if err != nil {
			return nil, false, fmt.Errorf("object listing: %w", err)
		}
		for _, c := range lr.Contents {
			if !strings.HasSuffix(c.Key, FileSuffix) {
				continue
			}
			lm, _ := time.Parse(time.RFC3339Nano, c.LastModified)
			out = append(out, Listed{Key: c.Key, ETag: unquote(c.ETag), Size: c.Size, LastModified: lm})
			if len(out) >= max {
				return out, true, nil
			}
		}
		if !lr.IsTruncated || lr.NextContinuationToken == "" {
			return out, false, nil
		}
		token = lr.NextContinuationToken
	}
}

// Version is one entry of a model's history.
type Version struct {
	VersionID    string    `json:"versionId"`
	ETag         string    `json:"etag"`
	Size         int64     `json:"size"`
	LastModified time.Time `json:"lastModified"`
	IsLatest     bool      `json:"isLatest"`
	Deleted      bool      `json:"deleted,omitempty"`
	Editor       string    `json:"editor,omitempty"`
}

type versionsResult struct {
	Versions []struct {
		Key          string `xml:"Key"`
		VersionID    string `xml:"VersionId"`
		IsLatest     bool   `xml:"IsLatest"`
		LastModified string `xml:"LastModified"`
		ETag         string `xml:"ETag"`
		Size         int64  `xml:"Size"`
	} `xml:"Version"`
	DeleteMarkers []struct {
		Key          string `xml:"Key"`
		VersionID    string `xml:"VersionId"`
		IsLatest     bool   `xml:"IsLatest"`
		LastModified string `xml:"LastModified"`
	} `xml:"DeleteMarker"`
}

// Versions lists a model's history, newest first, with the editor of the
// newest `withEditors` versions.
func (s *Store) Versions(req *http.Request, cluster string, client *aistor.Client, key string, max, withEditors int) ([]Version, error) {
	q := url.Values{"versions": {""}, "prefix": {key}, "max-keys": {strconv.Itoa(max)}}
	resp, err := s.do(req, cluster, client, &aistor.ObjectRequest{Method: http.MethodGet, Query: q})
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, s.fail(resp, "s3:ListBucketVersions", key)
	}
	var vr versionsResult
	if err := xml.NewDecoder(io.LimitReader(resp.Body, 16<<20)).Decode(&vr); err != nil {
		return nil, fmt.Errorf("version listing: %w", err)
	}
	var out []Version
	for _, v := range vr.Versions {
		if v.Key != key {
			continue
		}
		lm, _ := time.Parse(time.RFC3339Nano, v.LastModified)
		out = append(out, Version{VersionID: v.VersionID, ETag: unquote(v.ETag), Size: v.Size, LastModified: lm, IsLatest: v.IsLatest})
	}
	for _, d := range vr.DeleteMarkers {
		if d.Key != key {
			continue
		}
		lm, _ := time.Parse(time.RFC3339Nano, d.LastModified)
		out = append(out, Version{VersionID: d.VersionID, LastModified: lm, IsLatest: d.IsLatest, Deleted: true})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].LastModified.After(out[j].LastModified) })
	if len(out) > max {
		out = out[:max]
	}
	for i := range out {
		if i >= withEditors || out[i].Deleted || out[i].VersionID == "" {
			continue
		}
		h := url.Values{"versionId": {out[i].VersionID}}
		resp, err := s.do(req, cluster, client, &aistor.ObjectRequest{Method: http.MethodHead, Key: key, Query: h})
		if err != nil {
			continue
		}
		out[i].Editor = resp.Header.Get(EditorMeta)
		resp.Body.Close()
	}
	return out, nil
}
