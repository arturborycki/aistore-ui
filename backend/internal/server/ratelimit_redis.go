package server

import (
	"context"
	"log/slog"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

// redisLimiter is a fixed-window (per minute) limiter shared by all replicas.
// If Redis is unreachable it fails open (and logs), preferring availability
// of the UI over strict throttling; per-replica limits still apply upstream.
type redisLimiter struct {
	c      redis.UniversalClient
	prefix string
	perMin int64
	log    *slog.Logger
}

func newRedisLimiter(c redis.UniversalClient, name string, perMinute int, log *slog.Logger) *redisLimiter {
	return &redisLimiter{c: c, prefix: "aistor-ui:rl:" + name + ":", perMin: int64(perMinute), log: log}
}

func (l *redisLimiter) allow(ctx context.Context, key string) bool {
	window := time.Now().Unix() / 60
	k := l.prefix + key + ":" + strconv.FormatInt(window, 10)
	ctx, cancel := context.WithTimeout(ctx, 500*time.Millisecond)
	defer cancel()
	pipe := l.c.TxPipeline()
	incr := pipe.Incr(ctx, k)
	pipe.Expire(ctx, k, 70*time.Second)
	if _, err := pipe.Exec(ctx); err != nil {
		l.log.Warn("rate limiter unavailable; allowing request", "err", err)
		return true
	}
	return incr.Val() <= l.perMin
}
