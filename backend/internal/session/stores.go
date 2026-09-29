package session

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// MemoryStore is a process-local store. It is suitable for a single replica;
// use Redis when running more than one replica.
type MemoryStore struct {
	mu   sync.Mutex
	data map[string]memEntry
	stop chan struct{}
}

type memEntry struct {
	v   []byte
	exp time.Time
}

func NewMemoryStore() *MemoryStore {
	s := &MemoryStore{data: map[string]memEntry{}, stop: make(chan struct{})}
	go s.janitor()
	return s
}

func (s *MemoryStore) janitor() {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		select {
		case <-s.stop:
			return
		case now := <-t.C:
			s.mu.Lock()
			for k, e := range s.data {
				if now.After(e.exp) {
					delete(s.data, k)
				}
			}
			s.mu.Unlock()
		}
	}
}

func (s *MemoryStore) Close() { close(s.stop) }

func (s *MemoryStore) Get(_ context.Context, key string) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.data[key]
	if !ok || time.Now().After(e.exp) {
		delete(s.data, key)
		return nil, ErrNotFound
	}
	return append([]byte(nil), e.v...), nil
}

func (s *MemoryStore) Set(_ context.Context, key string, value []byte, ttl time.Duration) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data[key] = memEntry{v: append([]byte(nil), value...), exp: time.Now().Add(ttl)}
	return nil
}

func (s *MemoryStore) Delete(_ context.Context, key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.data, key)
	return nil
}

func (s *MemoryStore) Ping(context.Context) error { return nil }

// RedisStore stores sessions in Redis (or any RESP-compatible server).
type RedisStore struct{ c redis.UniversalClient }

func NewRedisStore(url string) (*RedisStore, error) {
	opt, err := redis.ParseURL(url)
	if err != nil {
		return nil, err
	}
	return &RedisStore{c: redis.NewClient(opt)}, nil
}

// NewRedisStoreFromClient wraps an existing client (used by tests and for sharing a pool).
func NewRedisStoreFromClient(c redis.UniversalClient) *RedisStore { return &RedisStore{c: c} }

func (s *RedisStore) Client() redis.UniversalClient { return s.c }

func (s *RedisStore) Get(ctx context.Context, key string) ([]byte, error) {
	b, err := s.c.Get(ctx, key).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, ErrNotFound
	}
	return b, err
}

func (s *RedisStore) Set(ctx context.Context, key string, value []byte, ttl time.Duration) error {
	return s.c.Set(ctx, key, value, ttl).Err()
}

func (s *RedisStore) Delete(ctx context.Context, key string) error {
	return s.c.Del(ctx, key).Err()
}

func (s *RedisStore) Ping(ctx context.Context) error { return s.c.Ping(ctx).Err() }
