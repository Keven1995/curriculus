import assert from "node:assert/strict";
import test from "node:test";
import { validatePixPaymentRequest } from "./payment-request.js";

test("accepts and normalizes the payer email without accepting client-controlled prices", () => {
  assert.deepEqual(validatePixPaymentRequest({ payerEmail: "  buyer@example.com  " }), {
    success: true,
    data: { payerEmail: "buyer@example.com" },
  });
});

test("rejects missing, malformed, oversized emails, arrays, and unknown fields", () => {
  for (const input of [
    {},
    { payerEmail: "not-an-email" },
    { payerEmail: "a".repeat(250) + "@example.com" },
    { payerEmail: 42 },
    { payerEmail: "buyer@example.com", amountCents: 1 },
    ["buyer@example.com"],
    null,
  ]) {
    assert.equal(validatePixPaymentRequest(input).success, false);
  }
});
