import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRateLimiter } from "./in-memory-rate-limiter.js";

test("limits a key for its window and reports a retry delay", () => {
  let now = 1_000;
  const limiter = new InMemoryRateLimiter(() => now);
  const policy = { limit: 2, windowMs: 1_000 };

  assert.deepEqual(limiter.consume("analysis", "127.0.0.1", policy), {
    allowed: true, remaining: 1, retryAfterSeconds: 1,
  });
  assert.equal(limiter.consume("analysis", "127.0.0.1", policy).allowed, true);
  assert.deepEqual(limiter.consume("analysis", "127.0.0.1", policy), {
    allowed: false, remaining: 0, retryAfterSeconds: 1,
  });
  now += 1_001;
  assert.equal(limiter.consume("analysis", "127.0.0.1", policy).allowed, true);
});

test("isolates route scopes and clients, bounds memory, and recovers expired buckets", () => {
  let now = 0;
  const limiter = new InMemoryRateLimiter(() => now, 2);
  const policy = { limit: 1, windowMs: 100 };

  assert.equal(limiter.consume("analysis", "one", policy).allowed, true);
  assert.equal(limiter.consume("payment", "one", policy).allowed, true);
  assert.equal(limiter.bucketCount <= 2, true);
  assert.equal(limiter.consume("analysis", "three", policy).allowed, true);
  assert.equal(limiter.bucketCount <= 2, true);
  now = 101;
  assert.equal(limiter.consume("analysis", "one", policy).allowed, true);
});

test("normalizes unusual client identifiers into a bounded fallback key", () => {
  const limiter = new InMemoryRateLimiter(() => 0);
  const policy = { limit: 1, windowMs: 1_000 };

  assert.equal(limiter.consume("global", "x".repeat(10_000), policy).allowed, true);
  assert.equal(limiter.consume("global", "y".repeat(10_000), policy).allowed, false);
});

test("does not expire a slow route bucket because a different route has a shorter window", () => {
  let now = 0;
  const limiter = new InMemoryRateLimiter(() => now);
  assert.equal(limiter.consume("analysis", "client", { limit: 1, windowMs: 900_000 }).allowed, true);
  now = 60_001;
  assert.equal(limiter.consume("paymentStatus", "client", { limit: 100, windowMs: 60_000 }).allowed, true);
  assert.equal(limiter.consume("analysis", "client", { limit: 1, windowMs: 900_000 }).allowed, false);
});
