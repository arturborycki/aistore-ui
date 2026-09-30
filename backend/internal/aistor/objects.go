package aistor

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"

	"github.com/arturborycki/aistore-ui/backend/internal/session"
)

// S3SigningService is the SigV4 service for plain object storage requests.
const S3SigningService = "s3"

// ObjectRequest is a path-style S3 request (/<bucket>/<key>) on the cluster's
// endpoint. Bucket and key are escaped here, segment by segment, so a key can
// never change the bucket or add query parameters.
type ObjectRequest struct {
	Method    string
	Bucket    string
	Key       string // may contain "/"; empty for bucket-level requests
	Query     url.Values
	Header    http.Header // e.g. If-Match, If-None-Match, Content-Type, x-amz-meta-*
	Body      []byte
	RequestID string
}

func (r *ObjectRequest) paths() (raw, decoded string) {
	var rb, db strings.Builder
	rb.WriteString("/" + escapeSegment(r.Bucket))
	db.WriteString("/" + r.Bucket)
	if r.Key != "" {
		for _, s := range strings.Split(r.Key, "/") {
			rb.WriteString("/" + escapeSegment(s))
			db.WriteString("/" + s)
		}
	}
	return rb.String(), db.String()
}

// DoObject sends a signed S3 request with the caller's credentials.
// The caller must close the response body.
func (c *Client) DoObject(ctx context.Context, creds *session.Credentials, r *ObjectRequest) (*http.Response, error) {
	raw, decoded := r.paths()
	u := *c.base
	u.Path = decoded
	u.RawPath = raw
	if len(r.Query) > 0 {
		// S3 expects %20 rather than + in query strings.
		u.RawQuery = strings.ReplaceAll(r.Query.Encode(), "+", "%20")
	}
	var body io.Reader
	if r.Body != nil {
		body = bytes.NewReader(r.Body)
	}
	req, err := http.NewRequestWithContext(ctx, r.Method, u.String(), body)
	if err != nil {
		return nil, err
	}
	req.URL.Path = decoded
	req.URL.RawPath = raw
	for k, vs := range r.Header {
		req.Header[http.CanonicalHeaderKey(k)] = vs
	}
	if r.RequestID != "" {
		req.Header.Set("X-Request-Id", r.RequestID)
	}
	sum := sha256.Sum256(r.Body)
	ph := hex.EncodeToString(sum[:])
	req.Header.Set("X-Amz-Content-Sha256", ph)
	ac := aws.Credentials{AccessKeyID: creds.AccessKey, SecretAccessKey: creds.SecretKey, SessionToken: creds.SessionToken}
	if err := c.signer.SignHTTP(ctx, ac, req, ph, S3SigningService, c.cfg.Region, c.now()); err != nil {
		return nil, err
	}
	return c.http.Do(req)
}
