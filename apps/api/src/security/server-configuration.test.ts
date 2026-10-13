import assert from "node:assert/strict";
import test from "node:test";
import {
  isStrongSecret,
  matchesBearerSecret,
  parseTrustedProxyHops,
  resolveCorsOrigin,
} from "./server-configuration.js";

test("uses localhost only for development and requires an explicit HTTPS origin in production", () => {
  assert.equal(resolveCorsOrigin(undefined, false), "http://localhost:3000");
  assert.equal(resolveCorsOrigin(undefined, true), null);
  assert.equal(resolveCorsOrigin("https://curriculus.example", true), "https://curriculus.example");
  assert.equal(resolveCorsOrigin("http://curriculus.example", true), null);
});

test("rejects wildcard, credentialed, and path-bearing CORS origins", () => {
  assert.equal(resolveCorsOrigin("*", false), null);
  assert.equal(resolveCorsOrigin("https://user:pass@example.test", false), null);
  assert.equal(resolveCorsOrigin("https://example.test/app", false), null);
  assert.equal(resolveCorsOrigin("https://example.test///", false), null);
  assert.equal(resolveCorsOrigin("https://example.test?next=/app", false), null);
  assert.equal(resolveCorsOrigin("https://example.test/", false), "https://example.test");
});

test("accepts only a small explicit trusted proxy hop count", () => {
  assert.equal(parseTrustedProxyHops(undefined), 0);
  assert.equal(parseTrustedProxyHops("1"), 1);
  assert.equal(parseTrustedProxyHops("2"), 2);
  assert.equal(parseTrustedProxyHops("true"), 0);
  assert.equal(parseTrustedProxyHops("99"), 0);
  assert.equal(parseTrustedProxyHops("1,2"), 0);
});

test("requires secrets to have at least 32 UTF-8 bytes", () => {
  assert.equal(isStrongSecret("a".repeat(32)), true);
  assert.equal(isStrongSecret("é".repeat(16)), true);
  assert.equal(isStrongSecret("a".repeat(31)), false);
  assert.equal(isStrongSecret(" ".repeat(32)), false);
  assert.equal(isStrongSecret("a ".repeat(16)), false);
});

test("matches a bearer secret exactly and refuses weak configured credentials", () => {
  const secret = "strong-metrics-secret-with-32-byte-minimum";
  assert.equal(matchesBearerSecret(secret, `Bearer ${secret}`), true);
  assert.equal(matchesBearerSecret(secret, `Bearer ${secret}x`), false);
  assert.equal(matchesBearerSecret(secret, secret), false);
  assert.equal(matchesBearerSecret("short", "Bearer short"), false);
});
