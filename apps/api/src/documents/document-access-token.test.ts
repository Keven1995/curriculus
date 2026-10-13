import assert from "node:assert/strict";
import test from "node:test";
import {
  createDocumentAccessToken,
  verifyDocumentAccessToken,
} from "./document-access-token.js";

const secret = "a-private-test-secret-with-at-least-32-characters";
const sessionId = "4e4f8a8c-7c1f-4fa7-a5a5-83eb983437ea";
const expiresAt = new Date("2026-01-02T00:00:00.000Z");

test("signs a private download capability bound to the session and exact expiry", () => {
  const token = createDocumentAccessToken(secret, sessionId, expiresAt);

  assert.equal(
    verifyDocumentAccessToken(secret, token, sessionId, new Date("2026-01-01T23:59:59.000Z"))?.getTime(),
    expiresAt.getTime(),
  );
  assert.equal(verifyDocumentAccessToken(secret, token, "another-session", new Date("2026-01-01T00:00:00.000Z")), null);
  assert.equal(verifyDocumentAccessToken(secret, `${token}x`, sessionId, new Date("2026-01-01T00:00:00.000Z")), null);
});

test("rejects an expired, malformed, or tampered download capability", () => {
  const token = createDocumentAccessToken(secret, sessionId, expiresAt);

  assert.equal(verifyDocumentAccessToken(secret, token, sessionId, expiresAt), null);
  assert.equal(verifyDocumentAccessToken(secret, "not-a-token", sessionId, new Date("2026-01-01T00:00:00.000Z")), null);
  assert.equal(verifyDocumentAccessToken("", token, sessionId, new Date("2026-01-01T00:00:00.000Z")), null);
});
