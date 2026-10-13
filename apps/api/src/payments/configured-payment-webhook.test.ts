import assert from "node:assert/strict";
import test from "node:test";
import type { SessionRepository } from "../persistence/session-repository.js";
import { createConfiguredPaymentWebhook } from "./configured-payment-webhook.js";

const repository = {} as unknown as SessionRepository;
const accessToken = "test-mercado-access-token-with-at-least-32-bytes";
const webhookSecret = "test-mercado-webhook-secret-with-at-least-32-bytes";

test("keeps the webhook disabled unless both the access token and signing secret are configured", () => {
  assert.equal(createConfiguredPaymentWebhook(repository, {} as NodeJS.ProcessEnv), undefined);
  assert.equal(createConfiguredPaymentWebhook(repository, {
    MERCADOPAGO_ACCESS_TOKEN: accessToken,
  } as NodeJS.ProcessEnv), undefined);
  assert.equal(createConfiguredPaymentWebhook(repository, {
    MERCADOPAGO_WEBHOOK_SECRET: webhookSecret,
  } as NodeJS.ProcessEnv), undefined);
  assert.equal(createConfiguredPaymentWebhook(repository, {
    MERCADOPAGO_ACCESS_TOKEN: "short-token",
    MERCADOPAGO_WEBHOOK_SECRET: webhookSecret,
  } as NodeJS.ProcessEnv), undefined);
  assert.equal(createConfiguredPaymentWebhook(repository, {
    MERCADOPAGO_ACCESS_TOKEN: accessToken,
    MERCADOPAGO_WEBHOOK_SECRET: "short-secret",
  } as NodeJS.ProcessEnv), undefined);
});

test("configures the authoritative webhook service from server-only credentials", () => {
  const endpoint = createConfiguredPaymentWebhook(repository, {
    MERCADOPAGO_ACCESS_TOKEN: accessToken,
    MERCADOPAGO_WEBHOOK_SECRET: webhookSecret,
  } as NodeJS.ProcessEnv);

  assert.equal(endpoint?.secret, webhookSecret);
  assert.equal(typeof endpoint?.service.handlePaymentNotification, "function");
});
