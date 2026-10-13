import assert from "node:assert/strict";
import test from "node:test";
import { createConfiguredPixPaymentService } from "./configured-pix-payment-service.js";
import type { PixPaymentRepository } from "./pix-payment-service.js";

const repository = {
  async isReady() { return true; },
  async createPendingOrder() { return null; },
  async savePixPayment() { return false; },
} as PixPaymentRepository;

test("keeps Mercado Pago disabled unless explicitly enabled with a server access token", () => {
  assert.equal(createConfiguredPixPaymentService(repository, {} as NodeJS.ProcessEnv), undefined);
  assert.equal(createConfiguredPixPaymentService(repository, {
    MERCADOPAGO_PIX_ENABLED: "true",
  } as NodeJS.ProcessEnv), undefined);
  assert.equal(createConfiguredPixPaymentService(repository, {
    MERCADOPAGO_ACCESS_TOKEN: "test-server-token",
  } as NodeJS.ProcessEnv), undefined);
});

test("creates the payment service only for an explicitly enabled provider configuration", () => {
  const service = createConfiguredPixPaymentService(repository, {
    MERCADOPAGO_PIX_ENABLED: "true",
    MERCADOPAGO_ACCESS_TOKEN: "test-server-token",
  } as NodeJS.ProcessEnv);

  assert.equal(typeof service?.createPixPayment, "function");
});
