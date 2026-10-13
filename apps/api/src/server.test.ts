import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "./app.js";
import { PixPaymentError } from "./payments/payment-errors.js";

const validRequest = {
  jobDescription: "Vaga de pessoa desenvolvedora",
  resume: "Experiência profissional em desenvolvimento",
  dataNoticeAcknowledged: true,
};

test("keeps the health endpoint available", async (context) => {
  const app = createApp({ analysisService: null, sessionRepository: null });
  context.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/health" });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    status: "ok",
    service: "curriculus-api",
  });
});

test("creates a pending Pix charge only after explicit email submission and never returns the email", async (context) => {
  let calls = 0;
  let submitted: { sessionId: string; payerEmail: string } | undefined;
  const app = createApp({
    analysisService: null,
    sessionRepository: null,
    pixPaymentService: {
      async createPixPayment(sessionId: string, payerEmail: string) {
        calls += 1;
        submitted = { sessionId, payerEmail };
        return {
          orderId: "order-test-id",
          amountCents: 199,
          currency: "BRL",
          status: "pending",
          expiresAt: new Date("2026-01-02T00:00:00.000Z"),
          qrCode: "pix-code",
          qrCodeBase64: "base64-code",
        };
      },
    },
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/sessions/4e4f8a8c-7c1f-4fa7-a5a5-83eb983437ea/payments/pix",
    payload: { payerEmail: "buyer@example.com" },
  });

  assert.equal(response.statusCode, 201);
  assert.equal(calls, 1);
  assert.deepEqual(submitted, {
    sessionId: "4e4f8a8c-7c1f-4fa7-a5a5-83eb983437ea",
    payerEmail: "buyer@example.com",
  });
  assert.deepEqual(response.json(), {
    orderId: "order-test-id",
    amountCents: 199,
    currency: "BRL",
    status: "pending",
    expiresAt: "2026-01-02T00:00:00.000Z",
    qrCode: "pix-code",
    qrCodeBase64: "base64-code",
  });
  assert.equal(response.body.includes("buyer@example.com"), false);
});

test("validates Pix payment input and fails closed when payment integration is disabled", async (context) => {
  const app = createApp({ analysisService: null, sessionRepository: null });
  context.after(() => app.close());

  const invalidEmail = await app.inject({
    method: "POST",
    url: "/sessions/session-test-id/payments/pix",
    payload: { payerEmail: "not-an-email" },
  });
  const extraPrice = await app.inject({
    method: "POST",
    url: "/sessions/session-test-id/payments/pix",
    payload: { payerEmail: "buyer@example.com", amountCents: 1 },
  });
  const unconfigured = await app.inject({
    method: "POST",
    url: "/sessions/session-test-id/payments/pix",
    payload: { payerEmail: "buyer@example.com" },
  });

  assert.equal(invalidEmail.statusCode, 400);
  assert.equal(invalidEmail.json().error.code, "INVALID_REQUEST");
  assert.equal(extraPrice.statusCode, 400);
  assert.equal(unconfigured.statusCode, 503);
  assert.equal(unconfigured.json().error.code, "PAYMENT_NOT_CONFIGURED");
});

test("maps provider failures to a safe response without exposing payment details", async (context) => {
  const app = createApp({
    analysisService: null,
    sessionRepository: null,
    pixPaymentService: {
      async createPixPayment() {
        throw new PixPaymentError("PROVIDER_UNAVAILABLE");
      },
    },
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/sessions/session-test-id/payments/pix",
    payload: { payerEmail: "buyer@example.com" },
  });

  assert.equal(response.statusCode, 502);
  assert.equal(response.json().error.code, "PROVIDER_UNAVAILABLE");
  assert.equal(response.body.includes("buyer@example.com"), false);
});

test("returns safe field errors for invalid analysis input", async (context) => {
  const app = createApp({ analysisService: null, sessionRepository: null });
  context.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/analyses",
    payload: {
      jobDescription: "",
      resume: { privateContent: "do-not-echo-this" },
      dataNoticeAcknowledged: true,
    },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, "INVALID_REQUEST");
  assert.equal(response.body.includes("do-not-echo-this"), false);
});

test("reports unavailable configuration without echoing the submitted content", async (context) => {
  const app = createApp({ analysisService: null, sessionRepository: null });
  context.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/analyses",
    payload: validRequest,
  });

  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, "ANALYSIS_NOT_CONFIGURED");
  assert.equal(response.body.includes(validRequest.resume), false);
});

test("runs the injected analysis service exactly once", async (context) => {
  let calls = 0;
  let saves = 0;
  const app = createApp({
    analysisService: {
      async analyze() {
        calls += 1;
        return {
          analysis: {
            jobRequirements: [],
            suggestions: [],
            documentStructure: { sectionOrder: [], suggestionOrder: [] },
          },
          usage: {
            inputTokens: 123,
            outputTokens: 456,
            totalTokens: 579,
            estimatedCostUsd: null,
          },
        };
      },
    },
    sessionRepository: {
      async isReady() {
        return true;
      },
      async createSession() {
        saves += 1;
        return {
          id: "session-test-id",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          expiresAt: new Date("2026-01-02T00:00:00.000Z"),
        };
      },
    } as never,
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/analyses",
    payload: validRequest,
  });

  assert.equal(response.statusCode, 201);
  assert.equal(calls, 1);
  assert.equal(saves, 1);
  assert.equal(response.json().sessionId, "session-test-id");
  assert.equal(response.json().usage.totalTokens, 579);
  assert.equal(response.body.includes(validRequest.resume), false);
});

test("requires pasted job text before any provider call", async (context) => {
  let calls = 0;
  const app = createApp({
    analysisService: {
      async analyze() {
        calls += 1;
        throw new Error("must not be called");
      },
    },
    sessionRepository: null,
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/analyses",
    payload: {
      jobUrl: "https://example.com/job",
      resume: validRequest.resume,
      dataNoticeAcknowledged: true,
    },
  });

  assert.equal(response.statusCode, 422);
  assert.equal(response.json().error.code, "JOB_DESCRIPTION_REQUIRED");
  assert.equal(calls, 0);
});

test("does not spend a model call when temporary persistence is unavailable", async (context) => {
  let calls = 0;
  const app = createApp({
    analysisService: {
      async analyze() {
        calls += 1;
        throw new Error("must not be called");
      },
    },
    sessionRepository: null,
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/analyses",
    payload: validRequest,
  });

  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, "PERSISTENCE_NOT_CONFIGURED");
  assert.equal(calls, 0);
});

test("does not spend a model call before the database schema is ready", async (context) => {
  let calls = 0;
  const app = createApp({
    analysisService: {
      async analyze() {
        calls += 1;
        throw new Error("must not be called");
      },
    },
    sessionRepository: {
      async isReady() {
        return false;
      },
    } as never,
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/analyses",
    payload: validRequest,
  });

  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, "PERSISTENCE_UNAVAILABLE");
  assert.equal(calls, 0);
});

test("rejects request bodies larger than 256 KiB", async (context) => {
  const app = createApp({ analysisService: null, sessionRepository: null });
  context.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/analyses",
    payload: {
      jobDescription: "vaga",
      resume: "r".repeat(270_000),
      dataNoticeAcknowledged: true,
    },
  });

  assert.equal(response.statusCode, 413);
  assert.equal(response.json().error.code, "PAYLOAD_TOO_LARGE");
  assert.equal(response.body.includes("rrrrrrrr"), false);
});
