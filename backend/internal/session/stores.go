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
	mu    sync.Mutex
	data  map[string]memEntry
	index map[string]map[string]string // subject → handle → key
	stop  chan struct{}
}

type memEntry struct {
	v   []byte
	exp time.Time
}

func NewMemoryStore() *MemoryStore {
	s := &MemoryStore{data: map[string]memEntry{}, index: map[string]map[string]string{}, stop: make(chan struct{})}
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

func (s *MemoryStore) IndexPut(_ context.Context, subject, handle, key string, _ time.Duration) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.index[subject] == nil {
		s.index[subject] = map[string]string{}
	}
	s.index[subject][handle] = key
	return nil
}

func (s *MemoryStore) IndexDel(_ context.Context, subject, handle string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.index[subject], handle)
	if len(s.index[subject]) == 0 {
		delete(s.index, subject)
	}
	return nil
}

func (s *MemoryStore) IndexGet(_ context.Context, subject string) (map[string]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := map[string]string{}
	for k, v := range s.index[subject] {
		out[k] = v
	}
	return out, nil
}

func (s *MemoryStore) IndexSubjects(context.Context) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, 0, len(s.index))
	for k := range s.index {
		out = append(out, k)
	}
	return out, nil
}

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

const (
	redisIndexPrefix = "aistor-ui:sidx:"
	redisSubjects    = "aistor-ui:sidx-subjects"
)

func (s *RedisStore) IndexPut(ctx context.Context, subject, handle, key string, ttl time.Duration) error {
	k := redisIndexPrefix + subject
	pipe := s.c.TxPipeline()
	pipe.HSet(ctx, k, handle, key)
	// The index lives as long as the longest session it references.
	pipe.Expire(ctx, k, ttl+time.Hour)
	pipe.SAdd(ctx, redisSubjects, subject)
	_, err := pipe.Exec(ctx)
	return err
}

func (s *RedisStore) IndexDel(ctx context.Context, subject, handle string) error {
	k := redisIndexPrefix + subject
	if err := s.c.HDel(ctx, k, handle).Err(); err != nil {
		return err
	}
	if n, _ := s.c.HLen(ctx, k).Result(); n == 0 {
		s.c.SRem(ctx, redisSubjects, subject)
	}
	return nil
}

func (s *RedisStore) IndexGet(ctx context.Context, subject string) (map[string]string, error) {
	return s.c.HGetAll(ctx, redisIndexPrefix+subject).Result()
}

func (s *RedisStore) IndexSubjects(ctx context.Context) ([]string, error) {
	return s.c.SMembers(ctx, redisSubjects).Result()
}
