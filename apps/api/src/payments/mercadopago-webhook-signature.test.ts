import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { verifyMercadoPagoWebhookSignature } from "./mercadopago-webhook-signature.js";

const secret = "webhook-test-secret";
const timestamp = "1767225600";
const requestId = "request-abc-123";
const paymentId = "123456789";

function signatureFor(id = paymentId, request = requestId, ts = timestamp) {
  const manifest = `id:${id.toLowerCase()};request-id:${request};ts:${ts};`;
  const digest = createHmac("sha256", secret).update(manifest).digest("hex");
  return `ts=${ts},v1=${digest}`;
}

test("validates Mercado Pago HMAC signatures using the signed payment id and request id", () => {
  assert.equal(
    verifyMercadoPagoWebhookSignature(secret, signatureFor(), requestId, paymentId),
    true,
  );
  assert.equal(
    verifyMercadoPagoWebhookSignature(secret, signatureFor("ABC123"), requestId, "abc123"),
    true,
  );
});

test("rejects altered, malformed, duplicated, or incomplete signatures", () => {
  const valid = signatureFor();
  const digest = valid.split("v1=")[1];

  assert.equal(verifyMercadoPagoWebhookSignature(secret, valid, requestId, "987654321"), false);
  assert.equal(verifyMercadoPagoWebhookSignature(secret, valid, "different-request", paymentId), false);
  assert.equal(verifyMercadoPagoWebhookSignature(secret, `${valid.slice(0, -1)}0`, requestId, paymentId), false);
  assert.equal(verifyMercadoPagoWebhookSignature(secret, `ts=${timestamp},ts=${timestamp},v1=${digest}`, requestId, paymentId), false);
  assert.equal(verifyMercadoPagoWebhookSignature(secret, `ts=${timestamp}`, requestId, paymentId), false);
  assert.equal(verifyMercadoPagoWebhookSignature("", valid, requestId, paymentId), false);
  assert.equal(verifyMercadoPagoWebhookSignature(secret, valid, "", paymentId), false);
});
