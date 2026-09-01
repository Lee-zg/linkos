package main

import (
	"sort"
	"sync"
	"time"
)

const rateLimiterMaxKeys = 4096

type rateBucket struct {
	tokens float64
	last   time.Time
}

// rateLimiter is a per-key token bucket. The bucket map is pruned when it
// exceeds rateLimiterMaxKeys so disconnected clients cannot grow memory
// without bound.
type rateLimiter struct {
	mu              sync.Mutex
	capacity        float64
	refillPerSecond float64
	now             func() time.Time
	buckets         map[string]*rateBucket
}

func newRateLimiter(capacity int, refillPerSecond float64) *rateLimiter {
	return newRateLimiterWithClock(capacity, refillPerSecond, func() time.Time { return time.Now() })
}

func newRateLimiterWithClock(capacity int, refillPerSecond float64, now func() time.Time) *rateLimiter {
	return &rateLimiter{
		capacity:        float64(capacity),
		refillPerSecond: refillPerSecond,
		now:             now,
		buckets:         make(map[string]*rateBucket),
	}
}

func (l *rateLimiter) allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	bucket, ok := l.buckets[key]
	if !ok {
		bucket = &rateBucket{tokens: l.capacity, last: now}
		l.buckets[key] = bucket
		l.pruneLocked()
	} else if elapsed := now.Sub(bucket.last).Seconds(); elapsed > 0 {
		bucket.tokens += elapsed * l.refillPerSecond
		if bucket.tokens > l.capacity {
			bucket.tokens = l.capacity
		}
		bucket.last = now
	}
	if bucket.tokens >= 1 {
		bucket.tokens--
		return true
	}
	return false
}

func (l *rateLimiter) pruneLocked() {
	if len(l.buckets) <= rateLimiterMaxKeys {
		return
	}
	keys := make([]string, 0, len(l.buckets))
	for key := range l.buckets {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool {
		return l.buckets[keys[i]].last.Before(l.buckets[keys[j]].last)
	})
	for _, key := range keys[:len(keys)-rateLimiterMaxKeys] {
		delete(l.buckets, key)
	}
}

func (l *rateLimiter) size() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.buckets)
}
