import { createHmac, timingSafeEqual } from "node:crypto";

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MIN_SECRET_BYTES = 32;

function hasValidSecret(secret: string): boolean {
  return Buffer.byteLength(secret, "utf8") >= MIN_SECRET_BYTES;
}

function sign(secret: string, encodedPayload: string): Buffer {
  return createHmac("sha256", secret).update(encodedPayload).digest();
}

export function createDocumentAccessToken(
  secret: string,
  sessionId: string,
  expiresAt: Date,
): string {
  if (!hasValidSecret(secret) || !SESSION_ID_PATTERN.test(sessionId) || !Number.isFinite(expiresAt.getTime())) {
    throw new Error("Invalid document access token input.");
  }
  const payload = Buffer.from(`${sessionId}:${expiresAt.getTime()}`, "utf8").toString("base64url");
  const signature = sign(secret, payload).toString("base64url");
  return `${payload}.${signature}`;
}

export function verifyDocumentAccessToken(
  secret: string,
  token: string,
  expectedSessionId: string,
  now = new Date(),
): Date | null {
  if (
    !hasValidSecret(secret) ||
    !SESSION_ID_PATTERN.test(expectedSessionId) ||
    token.length > 512
  ) {
    return null;
  }

  const [payload, encodedSignature, ...extra] = token.split(".");
  if (!payload || !encodedSignature || extra.length > 0) return null;

  let received: Buffer;
  try {
    received = Buffer.from(encodedSignature, "base64url");
  } catch {
    return null;
  }
  const expected = sign(secret, payload);
  if (
    received.length !== expected.length ||
    received.toString("base64url") !== encodedSignature ||
    !timingSafeEqual(received, expected)
  ) {
    return null;
  }

  let decoded: string;
  try {
    decoded = Buffer.from(payload, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const match = /^([0-9a-f-]{36}):(\d{13})$/i.exec(decoded);
  if (!match || match[1]!.toLowerCase() !== expectedSessionId.toLowerCase()) return null;

  const expiry = new Date(Number(match[2]));
  if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= now.getTime()) return null;
  return expiry;
}
