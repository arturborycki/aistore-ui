// Package session implements server-side, encrypted user sessions.
//
// The browser only ever holds an opaque random session ID in an HttpOnly
// cookie. Everything else — identity, per-cluster STS credentials, OIDC
// tokens, the CSRF secret — lives in the store, sealed with AES-256-GCM and
// addressed by SHA-256(sessionID) so that a store dump yields neither usable
// cookies nor plaintext credentials.
package session

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"
)

var ErrNotFound = errors.New("session: not found")

// Credentials are short-lived STS credentials for one AIStor cluster.
type Credentials struct {
	AccessKey    string    `json:"ak"`
	SecretKey    string    `json:"sk"`
	SessionToken string    `json:"st"`
	Expiration   time.Time `json:"exp"`
}

// Valid reports whether the credentials remain usable for at least skew.
func (c *Credentials) Valid(now time.Time, skew time.Duration) bool {
	return c != nil && c.AccessKey != "" && now.Add(skew).Before(c.Expiration)
}

type User struct {
	Subject     string   `json:"sub"`
	Username    string   `json:"username"`
	DisplayName string   `json:"name,omitempty"`
	Email       string   `json:"email,omitempty"`
	Groups      []string `json:"groups,omitempty"`
	Method      string   `json:"method"` // oidc | ldap | builtin
	Admin       bool     `json:"admin"`
}

type OIDCTokens struct {
	IDToken      string    `json:"id,omitempty"`
	AccessToken  string    `json:"at,omitempty"`
	RefreshToken string    `json:"rt,omitempty"`
	Expiry       time.Time `json:"exp,omitempty"`
}

type Session struct {
	User           User                    `json:"user"`
	CreatedAt      time.Time               `json:"created"`
	LastSeen       time.Time               `json:"seen"`
	AbsoluteExpiry time.Time               `json:"absExp"`
	CSRFToken      string                  `json:"csrf"`
	StepUpAt       time.Time               `json:"stepUp,omitempty"`
	OIDC           *OIDCTokens             `json:"oidc,omitempty"`
	Creds          map[string]*Credentials `json:"creds,omitempty"`
	// ClusterErrors records clusters where credential exchange failed at login,
	// so the UI can explain why a cluster is unavailable.
	ClusterErrors map[string]string `json:"clusterErrors,omitempty"`
}

// Store persists sessions.
type Store interface {
	Get(ctx context.Context, key string) ([]byte, error)
	Set(ctx context.Context, key string, value []byte, ttl time.Duration) error
	Delete(ctx context.Context, key string) error
	Ping(ctx context.Context) error
}

// Manager seals sessions into a Store.
type Manager struct {
	store   Store
	keys    *Keyring
	idle    time.Duration
	absTTL  time.Duration
	nowFunc func() time.Time
}

func NewManager(store Store, keys *Keyring, idle, absolute time.Duration) *Manager {
	return &Manager{store: store, keys: keys, idle: idle, absTTL: absolute, nowFunc: time.Now}
}

func (m *Manager) now() time.Time { return m.nowFunc() }

// NewID returns a 256-bit random, URL-safe identifier.
func NewID() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

func storageKey(id string) string {
	h := sha256.Sum256([]byte(id))
	return "aistor-ui:sess:" + hex.EncodeToString(h[:])
}

// Create stores a fresh session and returns its ID.
func (m *Manager) Create(ctx context.Context, s *Session) (string, error) {
	now := m.now()
	s.CreatedAt = now
	s.LastSeen = now
	s.AbsoluteExpiry = now.Add(m.absTTL)
	s.CSRFToken = NewID()
	id := NewID()
	return id, m.Save(ctx, id, s)
}

// Save writes s back to the store with a TTL bounded by both idle and absolute timeouts.
func (m *Manager) Save(ctx context.Context, id string, s *Session) error {
	ttl := m.idle
	if rem := s.AbsoluteExpiry.Sub(m.now()); rem < ttl {
		ttl = rem
	}
	if ttl <= 0 {
		return m.Delete(ctx, id)
	}
	raw, err := json.Marshal(s)
	if err != nil {
		return err
	}
	key := storageKey(id)
	blob, err := m.keys.Seal(raw, []byte(key))
	if err != nil {
		return err
	}
	return m.store.Set(ctx, key, blob, ttl)
}

// Load fetches and decrypts a session, enforcing idle and absolute expiry.
func (m *Manager) Load(ctx context.Context, id string) (*Session, error) {
	if len(id) != 43 { // 32 bytes, raw base64url
		return nil, ErrNotFound
	}
	key := storageKey(id)
	blob, err := m.store.Get(ctx, key)
	if err != nil {
		return nil, err
	}
	raw, err := m.keys.Open(blob, []byte(key))
	if err != nil {
		_ = m.store.Delete(ctx, key)
		return nil, ErrNotFound
	}
	var s Session
	if err := json.Unmarshal(raw, &s); err != nil {
		return nil, ErrNotFound
	}
	now := m.now()
	if now.After(s.AbsoluteExpiry) || now.Sub(s.LastSeen) > m.idle {
		_ = m.store.Delete(ctx, key)
		return nil, ErrNotFound
	}
	return &s, nil
}

// Touch updates LastSeen (sliding idle window) at most once per minute to limit store writes.
func (m *Manager) Touch(ctx context.Context, id string, s *Session) error {
	if m.now().Sub(s.LastSeen) < time.Minute {
		return nil
	}
	s.LastSeen = m.now()
	return m.Save(ctx, id, s)
}

func (m *Manager) Delete(ctx context.Context, id string) error {
	return m.store.Delete(ctx, storageKey(id))
}

// Rotate moves a session to a new ID (e.g. on privilege change) and deletes the old one.
func (m *Manager) Rotate(ctx context.Context, oldID string, s *Session) (string, error) {
	id := NewID()
	if err := m.Save(ctx, id, s); err != nil {
		return "", err
	}
	_ = m.Delete(ctx, oldID)
	return id, nil
}

func (m *Manager) Ping(ctx context.Context) error { return m.store.Ping(ctx) }

// Keys exposes the keyring for other sealed artefacts (e.g. the OIDC state cookie).
func (m *Manager) Keys() *Keyring { return m.keys }

// IdleTimeout returns the configured idle timeout.
func (m *Manager) IdleTimeout() time.Duration { return m.idle }
