export type RateLimitPolicy = {
  limit: number;
  windowMs: number;
};

export type RateLimitDecision = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

type Bucket = {
  startedAt: number;
  count: number;
  touchedAt: number;
  windowMs: number;
};

const MAX_CLIENT_KEY_LENGTH = 128;

export class InMemoryRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxEntries = 10_000,
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error("Rate limiter capacity must be a positive integer.");
    }
  }

  get bucketCount(): number {
    return this.buckets.size;
  }

  consume(scope: string, clientId: string, policy: RateLimitPolicy): RateLimitDecision {
    if (!Number.isInteger(policy.limit) || policy.limit < 1 || !Number.isFinite(policy.windowMs) || policy.windowMs < 1) {
      throw new Error("Rate limit policy must use a positive limit and window.");
    }

    const now = this.now();
    const safeScope = scope.length <= 64 ? scope : "unknown-scope";
    const safeClient = clientId.length <= MAX_CLIENT_KEY_LENGTH && clientId.trim()
      ? clientId
      : "unknown-client";
    let key = `${safeScope}\u0000${safeClient}`;

    this.removeExpiredBuckets(now);
    if (!this.buckets.has(key) && this.buckets.size >= this.maxEntries) {
      key = `${safeScope}\u0000__overflow__`;
      if (!this.buckets.has(key) && this.buckets.size >= this.maxEntries) this.removeOldestBucket();
    }

    let bucket = this.buckets.get(key);
    if (!bucket || now < bucket.startedAt || now - bucket.startedAt >= policy.windowMs) {
      bucket = { startedAt: now, count: 0, touchedAt: now, windowMs: policy.windowMs };
      this.buckets.set(key, bucket);
    }

    bucket.touchedAt = now;
    if (bucket.count >= policy.limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((bucket.startedAt + policy.windowMs - now) / 1_000));
      return { allowed: false, remaining: 0, retryAfterSeconds };
    }

    bucket.count += 1;
    return {
      allowed: true,
      remaining: Math.max(0, policy.limit - bucket.count),
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.startedAt + policy.windowMs - now) / 1_000)),
    };
  }

  private removeExpiredBuckets(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (now < bucket.startedAt || now - bucket.startedAt >= bucket.windowMs) this.buckets.delete(key);
    }
  }

  private removeOldestBucket(): void {
    let oldestKey: string | undefined;
    let oldestTouch = Number.POSITIVE_INFINITY;
    for (const [key, bucket] of this.buckets) {
      if (bucket.touchedAt < oldestTouch) {
        oldestKey = key;
        oldestTouch = bucket.touchedAt;
      }
    }
    if (oldestKey) this.buckets.delete(oldestKey);
  }
}
