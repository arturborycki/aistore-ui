// Package aistor talks to a MinIO AIStor cluster: the STS endpoint (to obtain
// per-user temporary credentials) and the AIStor Tables catalog API under
// /_iceberg/v1, signing every catalog request with AWS SigV4 (service "s3tables").
package aistor

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	v4 "github.com/aws/aws-sdk-go-v2/aws/signer/v4"

	"github.com/arturborycki/aistore-ui/backend/internal/config"
	"github.com/arturborycki/aistore-ui/backend/internal/session"
)

const (
	CatalogBasePath = "/_iceberg/v1"
	SigningService  = "s3tables"
	stsVersion      = "2011-06-15"
	maxSTSResponse  = 1 << 20
)

// Client is bound to one configured cluster.
type Client struct {
	cfg    config.Cluster
	http   *http.Client
	signer *v4.Signer
	base   *url.URL
	sts    *url.URL
	now    func() time.Time
}

// allowInsecureTLS is flipped by a build-tagged file for development builds only.
var allowInsecureTLS = false

func NewClient(cfg config.Cluster) (*Client, error) {
	tlsCfg := &tls.Config{MinVersion: tls.VersionTLS12}
	if cfg.CAFile != "" {
		pem, err := os.ReadFile(cfg.CAFile)
		if err != nil {
			return nil, fmt.Errorf("cluster %s: read CA: %w", cfg.ID, err)
		}
		pool, err := x509.SystemCertPool()
		if err != nil || pool == nil {
			pool = x509.NewCertPool()
		}
		if !pool.AppendCertsFromPEM(pem) {
			return nil, fmt.Errorf("cluster %s: no certificates in %s", cfg.ID, cfg.CAFile)
		}
		tlsCfg.RootCAs = pool
	}
	if cfg.InsecureSkipVerify {
		if !allowInsecureTLS {
			return nil, fmt.Errorf("cluster %s: insecureSkipVerify requires a development build (-tags devtls)", cfg.ID)
		}
		tlsCfg.InsecureSkipVerify = true
	}
	tr := &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		TLSClientConfig:       tlsCfg,
		MaxIdleConns:          100,
		MaxIdleConnsPerHost:   32,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: cfg.Timeout,
		ForceAttemptHTTP2:     true,
	}
	base, err := url.Parse(strings.TrimSuffix(cfg.Endpoint, "/"))
	if err != nil {
		return nil, err
	}
	sts, err := url.Parse(strings.TrimSuffix(cfg.STSEndpoint, "/") + "/")
	if err != nil {
		return nil, err
	}
	return &Client{
		cfg: cfg,
		http: &http.Client{
			Transport: tr,
			Timeout:   cfg.Timeout,
			// Never follow redirects: a redirect would re-send signed requests elsewhere.
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
		signer: v4.NewSigner(func(o *v4.SignerOptions) {
			o.DisableURIPathEscaping = cfg.DisableDoubleEncoding
		}),
		base: base,
		sts:  sts,
		now:  time.Now,
	}, nil
}

func (c *Client) Cluster() config.Cluster { return c.cfg }

// ---------------------------------------------------------------- STS

// STSError is an error returned by the STS endpoint.
type STSError struct {
	Status  int
	Code    string
	Message string
}

func (e *STSError) Error() string {
	if e.Code == "" {
		return fmt.Sprintf("sts: HTTP %d", e.Status)
	}
	return fmt.Sprintf("sts: %s: %s", e.Code, e.Message)
}

// IsAuthFailure reports whether the STS error means the presented identity was rejected.
func IsAuthFailure(err error) bool {
	var se *STSError
	if !errors.As(err, &se) {
		return false
	}
	switch se.Code {
	case "AccessDenied", "InvalidIdentityToken", "InvalidClientTokenId", "SignatureDoesNotMatch", "InvalidAccessKeyId", "ExpiredToken", "InvalidParameterValue":
		return true
	}
	return se.Status == http.StatusForbidden || se.Status == http.StatusUnauthorized
}

func (c *Client) duration() string {
	return strconv.Itoa(int(c.cfg.STSDuration / time.Second))
}

// AssumeRoleWithWebIdentity exchanges an OIDC token for temporary credentials.
func (c *Client) AssumeRoleWithWebIdentity(ctx context.Context, token string) (*session.Credentials, error) {
	form := url.Values{
		"Action":           {"AssumeRoleWithWebIdentity"},
		"Version":          {stsVersion},
		"WebIdentityToken": {token},
		"DurationSeconds":  {c.duration()},
	}
	return c.postSTS(ctx, form, nil)
}

// AssumeRoleWithLDAPIdentity exchanges directory credentials for temporary credentials.
func (c *Client) AssumeRoleWithLDAPIdentity(ctx context.Context, username, password string) (*session.Credentials, error) {
	form := url.Values{
		"Action":          {"AssumeRoleWithLDAPIdentity"},
		"Version":         {stsVersion},
		"LDAPUsername":    {username},
		"LDAPPassword":    {password},
		"DurationSeconds": {c.duration()},
	}
	return c.postSTS(ctx, form, nil)
}

// AssumeRole exchanges a MinIO user's long-lived keys for temporary credentials.
func (c *Client) AssumeRole(ctx context.Context, accessKey, secretKey string) (*session.Credentials, error) {
	form := url.Values{
		"Action":          {"AssumeRole"},
		"Version":         {stsVersion},
		"DurationSeconds": {c.duration()},
	}
	return c.postSTS(ctx, form, &aws.Credentials{AccessKeyID: accessKey, SecretAccessKey: secretKey})
}

type stsResponse struct {
	Credentials struct {
		AccessKeyID     string `xml:"AccessKeyId"`
		SecretAccessKey string `xml:"SecretAccessKey"`
		SessionToken    string `xml:"SessionToken"`
		Expiration      string `xml:"Expiration"`
	} `xml:"Credentials"`
}

type stsEnvelope struct {
	Result []stsResponse `xml:",any"`
}

type stsErrorEnvelope struct {
	Error struct {
		Code    string `xml:"Code"`
		Message string `xml:"Message"`
	} `xml:"Error"`
}

func (c *Client) postSTS(ctx context.Context, form url.Values, signWith *aws.Credentials) (*session.Credentials, error) {
	body := []byte(form.Encode())
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.sts.String(), bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/xml")
	if signWith != nil {
		sum := sha256.Sum256(body)
		ph := hex.EncodeToString(sum[:])
		req.Header.Set("X-Amz-Content-Sha256", ph)
		if err := c.signer.SignHTTP(ctx, *signWith, req, ph, "sts", c.cfg.Region, c.now()); err != nil {
			return nil, err
		}
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("sts: %w", err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxSTSResponse))
	if err != nil {
		return nil, fmt.Errorf("sts: read: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		var e stsErrorEnvelope
		_ = xml.Unmarshal(raw, &e)
		return nil, &STSError{Status: resp.StatusCode, Code: e.Error.Code, Message: e.Error.Message}
	}
	var env stsEnvelope
	if err := xml.Unmarshal(raw, &env); err != nil {
		return nil, fmt.Errorf("sts: decode: %w", err)
	}
	for _, r := range env.Result {
		cr := r.Credentials
		if cr.AccessKeyID == "" {
			continue
		}
		exp, err := time.Parse(time.RFC3339, cr.Expiration)
		if err != nil {
			exp = c.now().Add(c.cfg.STSDuration)
		}
		return &session.Credentials{AccessKey: cr.AccessKeyID, SecretKey: cr.SecretAccessKey, SessionToken: cr.SessionToken, Expiration: exp}, nil
	}
	return nil, errors.New("sts: response contained no credentials")
}

// ---------------------------------------------------------------- Catalog

// Request is a catalog request relative to /_iceberg/v1.
type Request struct {
	Method string
	// Segments are the unescaped path segments after /_iceberg/v1. Each is
	// percent-encoded individually, so no caller-controlled value can inject
	// a path separator.
	Segments []string
	Query    url.Values
	Body     []byte
	// RequestID is propagated upstream for audit correlation.
	RequestID string
}

// EscapedPath returns the upstream path for r.
func (r *Request) EscapedPath() (raw, decoded string) {
	var rb, db strings.Builder
	rb.WriteString(CatalogBasePath)
	db.WriteString(CatalogBasePath)
	for _, s := range r.Segments {
		rb.WriteByte('/')
		rb.WriteString(escapeSegment(s))
		db.WriteByte('/')
		db.WriteString(s)
	}
	return rb.String(), db.String()
}

// escapeSegment percent-encodes everything except RFC 3986 unreserved characters.
func escapeSegment(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		ch := s[i]
		if ('a' <= ch && ch <= 'z') || ('A' <= ch && ch <= 'Z') || ('0' <= ch && ch <= '9') || ch == '-' || ch == '_' || ch == '.' || ch == '~' {
			b.WriteByte(ch)
		} else {
			fmt.Fprintf(&b, "%%%02X", ch)
		}
	}
	return b.String()
}

// Do sends a signed catalog request with the caller's credentials.
// The caller must close the response body.
func (c *Client) Do(ctx context.Context, creds *session.Credentials, r *Request) (*http.Response, error) {
	raw, decoded := r.EscapedPath()
	u := *c.base
	u.Path = decoded
	u.RawPath = raw
	if len(r.Query) > 0 {
		u.RawQuery = r.Query.Encode()
	}
	var body io.Reader
	if r.Body != nil {
		body = bytes.NewReader(r.Body)
	}
	req, err := http.NewRequestWithContext(ctx, r.Method, u.String(), body)
	if err != nil {
		return nil, err
	}
	// url.String() + parse may normalise the path; pin it exactly.
	req.URL.Path = decoded
	req.URL.RawPath = raw
	req.Header.Set("Accept", "application/json")
	if r.Body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if r.RequestID != "" {
		req.Header.Set("X-Request-Id", r.RequestID)
	}
	sum := sha256.Sum256(r.Body)
	ph := hex.EncodeToString(sum[:])
	req.Header.Set("X-Amz-Content-Sha256", ph)
	ac := aws.Credentials{AccessKeyID: creds.AccessKey, SecretAccessKey: creds.SecretKey, SessionToken: creds.SessionToken}
	if err := c.signer.SignHTTP(ctx, ac, req, ph, SigningService, c.cfg.Region, c.now()); err != nil {
		return nil, err
	}
	return c.http.Do(req)
}
