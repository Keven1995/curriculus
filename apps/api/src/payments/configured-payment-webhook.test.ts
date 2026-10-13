import assert from "node:assert/strict";
import test from "node:test";
import type { SessionRepository } from "../persistence/session-repository.js";
import { createConfiguredPaymentWebhook } from "./configured-payment-webhook.js";

const repository = {} as unknown as SessionRepository;

test("keeps the webhook disabled unless both the access token and signing secret are configured", () => {
  assert.equal(createConfiguredPaymentWebhook(repository, {} as NodeJS.ProcessEnv), undefined);
  assert.equal(createConfiguredPaymentWebhook(repository, {
    MERCADOPAGO_ACCESS_TOKEN: "server-token",
  } as NodeJS.ProcessEnv), undefined);
  assert.equal(createConfiguredPaymentWebhook(repository, {
    MERCADOPAGO_WEBHOOK_SECRET: "webhook-secret",
  } as NodeJS.ProcessEnv), undefined);
});

test("configures the authoritative webhook service from server-only credentials", () => {
  const endpoint = createConfiguredPaymentWebhook(repository, {
    MERCADOPAGO_ACCESS_TOKEN: "server-token",
    MERCADOPAGO_WEBHOOK_SECRET: "webhook-secret",
  } as NodeJS.ProcessEnv);

  assert.equal(endpoint?.secret, "webhook-secret");
  assert.equal(typeof endpoint?.service.handlePaymentNotification, "function");
});
