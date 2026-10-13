import { createHmac, timingSafeEqual } from "node:crypto";

type ParsedSignature = { timestamp: string; digest: string };

function parseSignature(value: string): ParsedSignature | undefined {
  const fields = new Map<string, string>();
  for (const entry of value.split(",")) {
    const separator = entry.indexOf("=");
    if (separator <= 0) return undefined;
    const name = entry.slice(0, separator).trim();
    const fieldValue = entry.slice(separator + 1).trim();
    if ((name !== "ts" && name !== "v1") || !fieldValue || fields.has(name)) return undefined;
    fields.set(name, fieldValue);
  }

  const timestamp = fields.get("ts");
  const digest = fields.get("v1");
  if (!timestamp || !digest || !/^\d{1,20}$/.test(timestamp) || !/^[a-f\d]{64}$/i.test(digest)) {
    return undefined;
  }
  return { timestamp, digest };
}

export function verifyMercadoPagoWebhookSignature(
  secret: string,
  signature: string,
  requestId: string,
  paymentId: string,
): boolean {
  if (
    !secret.trim() ||
    !requestId ||
    requestId.length > 128 ||
    !/^[a-z\d._-]+$/i.test(requestId) ||
    !/^[a-z\d_-]{1,64}$/i.test(paymentId)
  ) {
    return false;
  }

  const parsed = parseSignature(signature);
  if (!parsed) return false;

  const manifest = `id:${paymentId.toLowerCase()};request-id:${requestId};ts:${parsed.timestamp};`;
  const expected = createHmac("sha256", secret).update(manifest).digest();
  const received = Buffer.from(parsed.digest, "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}
