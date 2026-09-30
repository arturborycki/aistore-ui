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
	"sort"
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
	// Handle is a public, non-secret identifier for listing and revoking
	// sessions. It is unrelated to the session ID in the cookie.
	Handle    string `json:"handle,omitempty"`
	ClientIP  string `json:"ip,omitempty"`
	UserAgent string `json:"ua,omitempty"`
}

// Info describes a session for the "active sessions" views; it contains no secrets.
type Info struct {
	Handle         string    `json:"handle"`
	User           User      `json:"user"`
	CreatedAt      time.Time `json:"createdAt"`
	LastSeen       time.Time `json:"lastSeen"`
	AbsoluteExpiry time.Time `json:"expiresAt"`
	ClientIP       string    `json:"clientIp,omitempty"`
	UserAgent      string    `json:"userAgent,omitempty"`
	Current        bool      `json:"current"`
}

// Store persists sessions and a per-user index of their storage keys.
type Store interface {
	Get(ctx context.Context, key string) ([]byte, error)
	Set(ctx context.Context, key string, value []byte, ttl time.Duration) error
	Delete(ctx context.Context, key string) error
	Ping(ctx context.Context) error

	// IndexPut records handle → storage key for subject.
	IndexPut(ctx context.Context, subject, handle, key string, ttl time.Duration) error
	IndexDel(ctx context.Context, subject, handle string) error
	// IndexGet returns handle → storage key for subject.
	IndexGet(ctx context.Context, subject string) (map[string]string, error)
	// IndexSubjects lists subjects that have (or recently had) sessions.
	IndexSubjects(ctx context.Context) ([]string, error)
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

// SetClock replaces the manager's clock (tests).
func (m *Manager) SetClock(now func() time.Time) { m.nowFunc = now }

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
	s.Handle = NewID()[:22]
	id := NewID()
	if err := m.Save(ctx, id, s); err != nil {
		return "", err
	}
	return id, m.store.IndexPut(ctx, s.User.Subject, s.Handle, storageKey(id), m.absTTL)
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
	return m.loadKey(ctx, storageKey(id))
}

func (m *Manager) loadKey(ctx context.Context, key string) (*Session, error) {
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

// DeleteSession removes a session and its index entry (logout, revoke).
func (m *Manager) DeleteSession(ctx context.Context, id string, s *Session) error {
	if s != nil && s.Handle != "" {
		_ = m.store.IndexDel(ctx, s.User.Subject, s.Handle)
	}
	return m.Delete(ctx, id)
}

// Rotate moves a session to a new ID (e.g. on privilege change) and deletes the old one.
func (m *Manager) Rotate(ctx context.Context, oldID string, s *Session) (string, error) {
	id := NewID()
	if err := m.Save(ctx, id, s); err != nil {
		return "", err
	}
	if s.Handle != "" {
		if err := m.store.IndexPut(ctx, s.User.Subject, s.Handle, storageKey(id), s.AbsoluteExpiry.Sub(m.now())); err != nil {
			return "", err
		}
	}
	_ = m.Delete(ctx, oldID)
	return id, nil
}

// List returns the live sessions of subject; stale index entries are pruned.
// currentHandle marks the caller's own session.
func (m *Manager) List(ctx context.Context, subject, currentHandle string) ([]Info, error) {
	idx, err := m.store.IndexGet(ctx, subject)
	if err != nil {
		return nil, err
	}
	out := make([]Info, 0, len(idx))
	for handle, key := range idx {
		s, err := m.loadKey(ctx, key)
		if err != nil || s.User.Subject != subject {
			_ = m.store.IndexDel(ctx, subject, handle)
			continue
		}
		out = append(out, Info{Handle: handle, User: s.User, CreatedAt: s.CreatedAt, LastSeen: s.LastSeen, AbsoluteExpiry: s.AbsoluteExpiry,
			ClientIP: s.ClientIP, UserAgent: s.UserAgent, Current: handle == currentHandle})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].LastSeen.After(out[j].LastSeen) })
	return out, nil
}

// ListAll returns every live session (administrators).
func (m *Manager) ListAll(ctx context.Context, currentHandle string) ([]Info, error) {
	subs, err := m.store.IndexSubjects(ctx)
	if err != nil {
		return nil, err
	}
	var out []Info
	for _, sub := range subs {
		l, err := m.List(ctx, sub, currentHandle)
		if err != nil {
			return nil, err
		}
		out = append(out, l...)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].LastSeen.After(out[j].LastSeen) })
	return out, nil
}

// Revoke ends the session identified by (subject, handle). It reports ErrNotFound if unknown.
func (m *Manager) Revoke(ctx context.Context, subject, handle string) error {
	idx, err := m.store.IndexGet(ctx, subject)
	if err != nil {
		return err
	}
	key, ok := idx[handle]
	if !ok {
		return ErrNotFound
	}
	_ = m.store.IndexDel(ctx, subject, handle)
	return m.store.Delete(ctx, key)
}

func (m *Manager) Ping(ctx context.Context) error { return m.store.Ping(ctx) }

// Keys exposes the keyring for other sealed artefacts (e.g. the OIDC state cookie).
func (m *Manager) Keys() *Keyring { return m.keys }

// IdleTimeout returns the configured idle timeout.
func (m *Manager) IdleTimeout() time.Duration { return m.idle }
