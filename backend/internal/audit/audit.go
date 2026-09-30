// Package audit records who did what. Every record is written as a structured
// JSON log line (for SIEM ingestion), kept in a bounded store for the in-app
// activity view, and optionally POSTed to a webhook.
package audit

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/arturborycki/aistore-ui/backend/internal/catalog"
)

type Actor struct {
	Subject  string `json:"sub"`
	Username string `json:"username"`
	Method   string `json:"method,omitempty"`
}

type Record struct {
	Time      time.Time `json:"time"`
	RequestID string    `json:"requestId"`
	Kind      string    `json:"kind"` // catalog | auth
	Actor     Actor     `json:"actor"`
	ClientIP  string    `json:"clientIp,omitempty"`
	catalog.AuditEvent
}

// Store keeps recent records for display.
type Store interface {
	Append(ctx context.Context, r *Record) error
	// List returns the newest records first. An empty subject lists everyone's.
	List(ctx context.Context, subject string, limit int) ([]Record, error)
}

type Logger struct {
	log     *slog.Logger
	store   Store
	webhook string
	secret  []byte
	queue   chan []byte
	client  *http.Client
}

// Option configures a Logger.
type Option func(*Logger)

// WithWebhookSecret signs webhook deliveries with HMAC-SHA256 so receivers can
// verify their origin and integrity (see VerifySignature).
func WithWebhookSecret(secret string) Option {
	return func(l *Logger) {
		if secret != "" {
			l.secret = []byte(secret)
		}
	}
}

func NewLogger(log *slog.Logger, store Store, webhookURL string, opts ...Option) *Logger {
	l := &Logger{log: log, store: store, webhook: webhookURL}
	for _, o := range opts {
		o(l)
	}
	if webhookURL != "" {
		l.queue = make(chan []byte, 1024)
		l.client = &http.Client{Timeout: 10 * time.Second}
		go l.deliver()
	}
	return l
}

func (l *Logger) Record(ctx context.Context, r *Record) {
	if r.Time.IsZero() {
		r.Time = time.Now().UTC()
	}
	l.log.LogAttrs(ctx, slog.LevelInfo, "audit",
		slog.Bool("audit", true),
		slog.String("kind", oneLine(r.Kind)),
		slog.String("requestId", oneLine(r.RequestID)),
		slog.String("user", oneLine(r.Actor.Username)),
		slog.String("sub", oneLine(r.Actor.Subject)),
		slog.String("clientIp", oneLine(r.ClientIP)),
		slog.String("operation", oneLine(r.Operation)),
		slog.String("action", oneLine(r.Action)),
		slog.String("cluster", oneLine(r.Cluster)),
		slog.String("resource", oneLine(r.Resource)),
		slog.String("arn", oneLine(r.ARN)),
		slog.Any("params", r.Params),
		slog.Int("status", r.Status),
		slog.String("outcome", oneLine(r.Outcome)),
		slog.String("error", oneLine(r.Error)),
		slog.Int64("durationMs", r.DurationMs),
	)
	if l.store != nil {
		// Detach from request cancellation: the record must be kept even if the client went away.
		sctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
		if err := l.store.Append(sctx, r); err != nil {
			l.log.Warn("audit store append failed", "err", err)
		}
		cancel()
	}
	if l.queue != nil {
		b, _ := json.Marshal(r)
		select {
		case l.queue <- b:
		default:
			l.log.Warn("audit webhook queue full; record dropped from webhook (still logged)")
		}
	}
}

func (l *Logger) List(ctx context.Context, subject string, limit int) ([]Record, error) {
	if l.store == nil {
		return nil, nil
	}
	return l.store.List(ctx, subject, limit)
}

// Headers set on signed webhook deliveries.
const (
	HeaderTimestamp = "X-Aistor-Audit-Timestamp"
	HeaderSignature = "X-Aistor-Audit-Signature"
)

// Sign computes the delivery signature: "sha256=" + hex(HMAC(secret, timestamp + "." + body)).
func Sign(secret []byte, timestamp string, body []byte) string {
	m := hmac.New(sha256.New, secret)
	m.Write([]byte(timestamp))
	m.Write([]byte("."))
	m.Write(body)
	return "sha256=" + hex.EncodeToString(m.Sum(nil))
}

// VerifySignature checks a delivery and rejects timestamps older than maxAge (replay protection).
func VerifySignature(secret []byte, timestamp, signature string, body []byte, maxAge time.Duration) bool {
	ts, err := strconv.ParseInt(timestamp, 10, 64)
	if err != nil || time.Since(time.Unix(ts, 0)).Abs() > maxAge {
		return false
	}
	return hmac.Equal([]byte(Sign(secret, timestamp, body)), []byte(signature))
}

func (l *Logger) deliver() {
	for b := range l.queue {
		for attempt := 0; attempt < 3; attempt++ {
			req, err := http.NewRequest(http.MethodPost, l.webhook, bytes.NewReader(b))
			if err != nil {
				l.log.Error("audit webhook: bad URL", "err", err)
				break
			}
			req.Header.Set("Content-Type", "application/json")
			if l.secret != nil {
				ts := strconv.FormatInt(time.Now().Unix(), 10)
				req.Header.Set(HeaderTimestamp, ts)
				req.Header.Set(HeaderSignature, Sign(l.secret, ts, b))
			}
			resp, err := l.client.Do(req)
			if err == nil {
				resp.Body.Close()
				if resp.StatusCode < 300 {
					break
				}
			}
			time.Sleep(time.Duration(attempt+1) * time.Second)
		}
	}
}

// ---------------------------------------------------------------- stores

// MemoryStore keeps the newest N records globally and per user.
type MemoryStore struct {
	mu     sync.Mutex
	retain int
	all    []Record
	byUser map[string][]Record
}

func NewMemoryStore(retain int) *MemoryStore {
	return &MemoryStore{retain: retain, byUser: map[string][]Record{}}
}

func push(list []Record, r Record, max int) []Record {
	list = append(list, r)
	if len(list) > max {
		list = list[len(list)-max:]
	}
	return list
}

func (m *MemoryStore) Append(_ context.Context, r *Record) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.all = push(m.all, *r, m.retain)
	m.byUser[r.Actor.Subject] = push(m.byUser[r.Actor.Subject], *r, m.retain)
	return nil
}

func (m *MemoryStore) List(_ context.Context, subject string, limit int) ([]Record, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	src := m.all
	if subject != "" {
		src = m.byUser[subject]
	}
	out := make([]Record, 0, min(limit, len(src)))
	for i := len(src) - 1; i >= 0 && len(out) < limit; i-- {
		out = append(out, src[i])
	}
	return out, nil
}

// RedisStore keeps records in capped Redis lists.
type RedisStore struct {
	c      redis.UniversalClient
	retain int
}

func NewRedisStore(c redis.UniversalClient, retain int) *RedisStore {
	return &RedisStore{c: c, retain: retain}
}

const (
	redisAllKey  = "aistor-ui:audit:all"
	redisUserKey = "aistor-ui:audit:user:"
)

func (s *RedisStore) Append(ctx context.Context, r *Record) error {
	b, err := json.Marshal(r)
	if err != nil {
		return err
	}
	pipe := s.c.TxPipeline()
	for _, k := range []string{redisAllKey, redisUserKey + r.Actor.Subject} {
		pipe.LPush(ctx, k, b)
		pipe.LTrim(ctx, k, 0, int64(s.retain-1))
	}
	_, err = pipe.Exec(ctx)
	return err
}

func (s *RedisStore) List(ctx context.Context, subject string, limit int) ([]Record, error) {
	key := redisAllKey
	if subject != "" {
		key = redisUserKey + subject
	}
	vals, err := s.c.LRange(ctx, key, 0, int64(limit-1)).Result()
	if err != nil {
		return nil, err
	}
	out := make([]Record, 0, len(vals))
	for _, v := range vals {
		var r Record
		if json.Unmarshal([]byte(v), &r) == nil {
			out = append(out, r)
		}
	}
	return out, nil
}

// oneLine strips line breaks so a logged value cannot forge extra log lines
// (the handlers escape them too, but plain-text sinks may not).
func oneLine(s string) string {
	return strings.NewReplacer("\n", " ", "\r", " ").Replace(s)
}
