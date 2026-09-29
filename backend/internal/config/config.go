// Package config loads and validates the server configuration.
//
// Configuration is read from a YAML file (path in AISTOR_UI_CONFIG, default
// /etc/aistor-ui/config.yaml). ${VAR} references are expanded from the
// environment before parsing, and every secret can alternatively be supplied
// through a *File field so that secrets never have to live in the YAML itself.
package config

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

type Config struct {
	Server   Server    `yaml:"server"`
	Session  Session   `yaml:"session"`
	Auth     Auth      `yaml:"auth"`
	Clusters []Cluster `yaml:"clusters"`
	Audit    Audit     `yaml:"audit"`
	Limits   Limits    `yaml:"limits"`
}

type Server struct {
	Listen        string   `yaml:"listen"`        // e.g. ":8080"
	MetricsListen string   `yaml:"metricsListen"` // e.g. ":9090"; empty disables
	PublicURL     string   `yaml:"publicUrl"`     // externally visible origin, e.g. https://catalog.example.com
	TrustProxy    bool     `yaml:"trustProxy"`    // honour X-Forwarded-For for client IPs
	TLSCertFile   string   `yaml:"tlsCertFile"`   // optional: terminate TLS in-process
	TLSKeyFile    string   `yaml:"tlsKeyFile"`
	ExtraOrigins  []string `yaml:"extraOrigins"` // additional origins allowed for state-changing requests

	publicURL *url.URL
}

type Session struct {
	Store          string        `yaml:"store"` // "memory" or a redis:// / rediss:// URL
	Keys           []Key         `yaml:"keys"`  // first key encrypts, all keys decrypt
	IdleTimeout    time.Duration `yaml:"idleTimeout"`
	AbsoluteTTL    time.Duration `yaml:"absoluteTimeout"`
	StepUpValidFor time.Duration `yaml:"stepUpValidFor"`
	CookieName     string        `yaml:"cookieName"` // derived from PublicURL when empty
}

type Key struct {
	ID    string `yaml:"id"`
	Value string `yaml:"value"` // base64 or hex encoded 32 bytes
	File  string `yaml:"file"`

	bytes []byte
}

func (k Key) Bytes() []byte { return k.bytes }

type Auth struct {
	OIDC    OIDC    `yaml:"oidc"`
	LDAP    LDAP    `yaml:"ldap"`
	Builtin Builtin `yaml:"builtin"`
	// AdminGroups lists IdP groups whose members may see everyone's activity.
	AdminGroups []string `yaml:"adminGroups"`
	// AdminUsers lists usernames (any login method) with the same privilege.
	AdminUsers []string `yaml:"adminUsers"`
}

type OIDC struct {
	Enabled          bool     `yaml:"enabled"`
	DisplayName      string   `yaml:"displayName"`
	Issuer           string   `yaml:"issuer"`
	DiscoveryURL     string   `yaml:"discoveryUrl"` // optional split-horizon discovery base (issuer is still enforced on tokens)
	ClientID         string   `yaml:"clientId"`
	ClientSecret     string   `yaml:"clientSecret"`
	ClientSecretFile string   `yaml:"clientSecretFile"`
	Scopes           []string `yaml:"scopes"`
	GroupsClaim      string   `yaml:"groupsClaim"`
	UsernameClaim    string   `yaml:"usernameClaim"`
	// STSToken selects which token is presented to AssumeRoleWithWebIdentity: "id_token" (default) or "access_token".
	STSToken string `yaml:"stsToken"`
	// EndSessionRedirect enables RP-initiated logout when the provider supports it.
	EndSessionRedirect bool `yaml:"endSessionRedirect"`
}

type LDAP struct {
	Enabled     bool   `yaml:"enabled"`
	DisplayName string `yaml:"displayName"`
}

type Builtin struct {
	Enabled bool `yaml:"enabled"`
}

type Cluster struct {
	ID          string        `yaml:"id"`
	Name        string        `yaml:"name"`
	Endpoint    string        `yaml:"endpoint"`    // https://aistor.example.net:9000
	STSEndpoint string        `yaml:"stsEndpoint"` // defaults to Endpoint
	Region      string        `yaml:"region"`
	CAFile      string        `yaml:"caFile"`
	STSDuration time.Duration `yaml:"stsDuration"`
	// InsecureSkipVerify is only honoured when the binary is built with the "devtls" tag.
	InsecureSkipVerify bool          `yaml:"insecureSkipVerify"`
	Timeout            time.Duration `yaml:"timeout"`
	// DisableDoubleEncoding signs the canonical URI without the second round of
	// percent-encoding that AWS applies for non-S3 services. Leave false unless
	// multi-level namespaces fail with SignatureDoesNotMatch.
	DisableDoubleEncoding bool `yaml:"disableDoubleEncoding"`
}

type Audit struct {
	WebhookURL string `yaml:"webhookUrl"`
	// Retain is the number of audit events kept per user (and globally) for the in-app activity view.
	Retain int `yaml:"retain"`
}

type Limits struct {
	RequestsPerMinute int   `yaml:"requestsPerMinute"` // per session
	LoginPerMinute    int   `yaml:"loginPerMinute"`    // per client IP
	MaxBodyBytes      int64 `yaml:"maxBodyBytes"`
	PreviewMaxRows    int   `yaml:"previewMaxRows"`
}

var clusterIDRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)

// Load reads the configuration from path.
func Load(path string) (*Config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}
	return Parse(raw)
}

// Parse expands environment references, decodes YAML, applies defaults and validates.
func Parse(raw []byte) (*Config, error) {
	expanded := os.ExpandEnv(string(raw))
	var c Config
	dec := yaml.NewDecoder(strings.NewReader(expanded))
	dec.KnownFields(true)
	if err := dec.Decode(&c); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}
	c.applyDefaults()
	if err := c.resolveSecrets(); err != nil {
		return nil, err
	}
	if err := c.validate(); err != nil {
		return nil, err
	}
	return &c, nil
}

func (c *Config) applyDefaults() {
	if c.Server.Listen == "" {
		c.Server.Listen = ":8080"
	}
	if c.Session.Store == "" {
		c.Session.Store = "memory"
	}
	if c.Session.IdleTimeout == 0 {
		c.Session.IdleTimeout = 30 * time.Minute
	}
	if c.Session.AbsoluteTTL == 0 {
		c.Session.AbsoluteTTL = 12 * time.Hour
	}
	if c.Session.StepUpValidFor == 0 {
		c.Session.StepUpValidFor = 5 * time.Minute
	}
	if c.Auth.OIDC.DisplayName == "" {
		c.Auth.OIDC.DisplayName = "Single sign-on"
	}
	if len(c.Auth.OIDC.Scopes) == 0 {
		c.Auth.OIDC.Scopes = []string{"openid", "profile", "email"}
	}
	if c.Auth.OIDC.GroupsClaim == "" {
		c.Auth.OIDC.GroupsClaim = "groups"
	}
	if c.Auth.OIDC.UsernameClaim == "" {
		c.Auth.OIDC.UsernameClaim = "preferred_username"
	}
	if c.Auth.OIDC.STSToken == "" {
		c.Auth.OIDC.STSToken = "id_token"
	}
	if c.Auth.LDAP.DisplayName == "" {
		c.Auth.LDAP.DisplayName = "Directory (LDAP)"
	}
	for i := range c.Clusters {
		cl := &c.Clusters[i]
		if cl.STSEndpoint == "" {
			cl.STSEndpoint = cl.Endpoint
		}
		if cl.Region == "" {
			cl.Region = "us-east-1"
		}
		if cl.STSDuration == 0 {
			cl.STSDuration = time.Hour
		}
		if cl.Timeout == 0 {
			cl.Timeout = 30 * time.Second
		}
		if cl.Name == "" {
			cl.Name = cl.ID
		}
	}
	if c.Audit.Retain == 0 {
		c.Audit.Retain = 500
	}
	if c.Limits.RequestsPerMinute == 0 {
		c.Limits.RequestsPerMinute = 600
	}
	if c.Limits.LoginPerMinute == 0 {
		c.Limits.LoginPerMinute = 10
	}
	if c.Limits.MaxBodyBytes == 0 {
		c.Limits.MaxBodyBytes = 2 << 20
	}
	if c.Limits.PreviewMaxRows == 0 || c.Limits.PreviewMaxRows > 1000 {
		c.Limits.PreviewMaxRows = 1000
	}
}

func readSecretFile(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read secret file %s: %w", path, err)
	}
	return strings.TrimSpace(string(b)), nil
}

func (c *Config) resolveSecrets() error {
	if c.Auth.OIDC.ClientSecretFile != "" {
		s, err := readSecretFile(c.Auth.OIDC.ClientSecretFile)
		if err != nil {
			return err
		}
		c.Auth.OIDC.ClientSecret = s
	}
	for i := range c.Session.Keys {
		k := &c.Session.Keys[i]
		val := k.Value
		if k.File != "" {
			s, err := readSecretFile(k.File)
			if err != nil {
				return err
			}
			val = s
		}
		b, err := decodeKey(val)
		if err != nil {
			return fmt.Errorf("session key %q: %w", k.ID, err)
		}
		k.bytes = b
	}
	return nil
}

func decodeKey(v string) ([]byte, error) {
	v = strings.TrimSpace(v)
	if b, err := hex.DecodeString(v); err == nil && len(b) == 32 {
		return b, nil
	}
	for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
		if b, err := enc.DecodeString(v); err == nil && len(b) == 32 {
			return b, nil
		}
	}
	if len(v) >= 32 {
		// Accept a long passphrase by hashing it; warn-worthy but usable.
		h := sha256.Sum256([]byte(v))
		return h[:], nil
	}
	return nil, errors.New("must be 32 bytes (hex or base64) or a passphrase of at least 32 characters")
}

func (c *Config) validate() error {
	var errs []error
	if c.Server.PublicURL == "" {
		errs = append(errs, errors.New("server.publicUrl is required"))
	} else {
		u, err := url.Parse(c.Server.PublicURL)
		if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
			errs = append(errs, errors.New("server.publicUrl must be an absolute http(s) URL"))
		} else {
			u.Path = strings.TrimSuffix(u.Path, "/")
			c.Server.publicURL = u
			if u.Scheme == "http" && !isLoopback(u.Hostname()) {
				errs = append(errs, errors.New("server.publicUrl must use https unless it is a loopback address"))
			}
		}
	}
	if len(c.Session.Keys) == 0 {
		errs = append(errs, errors.New("session.keys: at least one encryption key is required"))
	}
	seen := map[string]bool{}
	for _, k := range c.Session.Keys {
		if k.ID == "" || seen[k.ID] {
			errs = append(errs, errors.New("session.keys: every key needs a unique id"))
		}
		seen[k.ID] = true
	}
	if !c.Auth.OIDC.Enabled && !c.Auth.LDAP.Enabled && !c.Auth.Builtin.Enabled {
		errs = append(errs, errors.New("auth: enable at least one of oidc, ldap, builtin"))
	}
	if c.Auth.OIDC.Enabled {
		if c.Auth.OIDC.Issuer == "" || c.Auth.OIDC.ClientID == "" {
			errs = append(errs, errors.New("auth.oidc: issuer and clientId are required"))
		}
		if c.Auth.OIDC.STSToken != "id_token" && c.Auth.OIDC.STSToken != "access_token" {
			errs = append(errs, errors.New("auth.oidc.stsToken must be id_token or access_token"))
		}
	}
	if len(c.Clusters) == 0 {
		errs = append(errs, errors.New("clusters: at least one cluster is required"))
	}
	ids := map[string]bool{}
	for _, cl := range c.Clusters {
		if !clusterIDRe.MatchString(cl.ID) || ids[cl.ID] {
			errs = append(errs, fmt.Errorf("clusters: id %q must be unique and match %s", cl.ID, clusterIDRe))
		}
		ids[cl.ID] = true
		for _, e := range []string{cl.Endpoint, cl.STSEndpoint} {
			u, err := url.Parse(e)
			if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" || (u.Path != "" && u.Path != "/") {
				errs = append(errs, fmt.Errorf("clusters[%s]: endpoint %q must be scheme://host[:port]", cl.ID, e))
			}
		}
	}
	return errors.Join(errs...)
}

// PublicURL returns the parsed public URL.
func (c *Config) PublicURL() *url.URL { u := *c.Server.publicURL; return &u }

// SecureCookies reports whether cookies must carry the Secure attribute.
func (c *Config) SecureCookies() bool {
	return c.Server.publicURL.Scheme == "https" || isLoopback(c.Server.publicURL.Hostname())
}

// CookieName returns the session cookie name. The __Host- prefix is used when
// cookies are secure, pinning the cookie to this exact host and path "/".
func (c *Config) CookieName() string {
	if c.Session.CookieName != "" {
		return c.Session.CookieName
	}
	if c.SecureCookies() {
		return "__Host-aistor_sid"
	}
	return "aistor_sid"
}

// AllowedOrigins returns the origins accepted for state-changing requests.
func (c *Config) AllowedOrigins() []string {
	u := c.Server.publicURL
	out := []string{u.Scheme + "://" + u.Host}
	out = append(out, c.Server.ExtraOrigins...)
	return out
}

func (c *Config) Cluster(id string) (*Cluster, bool) {
	for i := range c.Clusters {
		if c.Clusters[i].ID == id {
			return &c.Clusters[i], true
		}
	}
	return nil, false
}

func isLoopback(host string) bool {
	return host == "localhost" || host == "127.0.0.1" || host == "::1" || strings.HasSuffix(host, ".localhost")
}
