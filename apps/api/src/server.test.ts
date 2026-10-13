import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { createApp } from "./app.js";
import { PixPaymentError } from "./payments/payment-errors.js";
import { PaymentWebhookError } from "./payments/payment-webhook-service.js";
import { DocumentServiceError } from "./documents/document-service.js";

const validRequest = {
  jobDescription: "Vaga de pessoa desenvolvedora",
  resume: "Experiência profissional em desenvolvimento",
  dataNoticeAcknowledged: true,
};

const webhookSecret = "webhook-test-secret";
const webhookTimestamp = "1767225600";
const webhookRequestId = "request-abc-123";
const webhookPaymentId = "123456789";

function webhookSignature(paymentId = webhookPaymentId) {
  const manifest = `id:${paymentId.toLowerCase()};request-id:${webhookRequestId};ts:${webhookTimestamp};`;
  const digest = createHmac("sha256", webhookSecret).update(manifest).digest("hex");
  return `ts=${webhookTimestamp},v1=${digest}`;
}

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
    documentService: {
      async generateDocument() {
        return { format: "pdf" as const, downloadPath: "/", expiresAt: new Date(), created: true };
      },
      async downloadDocument() { return Buffer.from("pdf"); },
      async deleteExpiredDocuments() { return 0; },
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
    documentService: {
      async generateDocument() {
        return { format: "pdf" as const, downloadPath: "/", expiresAt: new Date(), created: true };
      },
      async downloadDocument() { return Buffer.from("pdf"); },
      async deleteExpiredDocuments() { return 0; },
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

test("does not create a Pix charge if private document delivery is not configured", async (context) => {
  let calls = 0;
  const app = createApp({
    analysisService: null,
    sessionRepository: null,
    pixPaymentService: {
      async createPixPayment() {
        calls += 1;
        throw new Error("should not charge");
      },
    },
    documentService: null,
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/sessions/session-test-id/payments/pix",
    payload: { payerEmail: "buyer@example.com" },
  });

  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, "DOCUMENT_NOT_CONFIGURED");
  assert.equal(calls, 0);
  assert.equal(response.body.includes("buyer@example.com"), false);
});

test("verifies Mercado Pago webhook authenticity before handling payment events", async (context) => {
  let calls = 0;
  let notifiedPaymentId = "";
  const app = createApp({
    analysisService: null,
    sessionRepository: null,
    paymentWebhook: {
      secret: webhookSecret,
      service: {
        async handlePaymentNotification(paymentId: string) {
          calls += 1;
          notifiedPaymentId = paymentId;
          return "processed" as const;
        },
      },
    },
  });
  context.after(() => app.close());

  const valid = await app.inject({
    method: "POST",
    url: `/webhooks/mercadopago?data.id=${webhookPaymentId}&type=payment`,
    headers: {
      "x-signature": webhookSignature(),
      "x-request-id": webhookRequestId,
    },
    payload: { type: "payment", data: { id: webhookPaymentId } },
  });
  const invalid = await app.inject({
    method: "POST",
    url: `/webhooks/mercadopago?data.id=${webhookPaymentId}&type=payment`,
    headers: { "x-signature": "ts=1767225600,v1=00", "x-request-id": webhookRequestId },
    payload: { type: "payment", data: { id: webhookPaymentId } },
  });

  assert.equal(valid.statusCode, 200);
  assert.equal(valid.json().received, true);
  assert.equal(invalid.statusCode, 401);
  assert.equal(calls, 1);
  assert.equal(notifiedPaymentId, webhookPaymentId);
});

test("ignores non-payment webhook events and fails closed when webhook verification is not configured", async (context) => {
  let calls = 0;
  const configuredApp = createApp({
    analysisService: null,
    sessionRepository: null,
    paymentWebhook: {
      secret: webhookSecret,
      service: {
        async handlePaymentNotification() {
          calls += 1;
          return "processed" as const;
        },
      },
    },
  });
  const unconfiguredApp = createApp({ analysisService: null, sessionRepository: null });
  context.after(async () => {
    await configuredApp.close();
    await unconfiguredApp.close();
  });

  const ignored = await configuredApp.inject({
    method: "POST",
    url: "/webhooks/mercadopago?type=merchant_order",
    payload: { type: "merchant_order" },
  });
  const unconfigured = await unconfiguredApp.inject({
    method: "POST",
    url: `/webhooks/mercadopago?data.id=${webhookPaymentId}&type=payment`,
    headers: { "x-signature": webhookSignature(), "x-request-id": webhookRequestId },
    payload: { type: "payment", data: { id: webhookPaymentId } },
  });

  assert.equal(ignored.statusCode, 200);
  assert.equal(unconfigured.statusCode, 503);
  assert.equal(calls, 0);
});

test("returns a retryable response when authoritative payment lookup fails", async (context) => {
  const app = createApp({
    analysisService: null,
    sessionRepository: null,
    paymentWebhook: {
      secret: webhookSecret,
      service: {
        async handlePaymentNotification() {
          throw new PaymentWebhookError("PROVIDER_UNAVAILABLE");
        },
      },
    },
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: `/webhooks/mercadopago?data.id=${webhookPaymentId}&type=payment`,
    headers: { "x-signature": webhookSignature(), "x-request-id": webhookRequestId },
    payload: { type: "payment", data: { id: webhookPaymentId } },
  });

  assert.equal(response.statusCode, 502);
  assert.equal(response.json().error.code, "PROVIDER_UNAVAILABLE");
  assert.equal(response.body.includes(webhookSecret), false);
});

test("returns only the server-side payment state for the session", async (context) => {
  let selectedSessionId = "";
  const app = createApp({
    analysisService: null,
    sessionRepository: {
      async isReady() { return true; },
      async findOrderBySessionId(sessionId: string) {
        selectedSessionId = sessionId;
        return {
          id: "order-1",
          sessionId,
          amountCents: 199 as const,
          currency: "BRL" as const,
          status: "approved" as const,
          providerPaymentId: "provider-id",
          pixQrCode: "private-qr",
          pixQrCodeBase64: "private-image",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          checkoutExpiresAt: new Date("2026-01-02T00:00:00.000Z"),
        };
      },
    } as never,
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/sessions/4e4f8a8c-7c1f-4fa7-a5a5-83eb983437ea/payments/status",
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "approved" });
  assert.equal(selectedSessionId, "4e4f8a8c-7c1f-4fa7-a5a5-83eb983437ea");
  assert.equal(response.body.includes("private-qr"), false);
  assert.equal(response.body.includes("provider-id"), false);
});

test("generates a PDF link only from approved suggestion IDs and serves it privately", async (context) => {
  let requested: { sessionId: string; approvedSuggestionIds: readonly string[] } | undefined;
  let downloaded: { sessionId: string; token: string } | undefined;
  const app = createApp({
    analysisService: null,
    sessionRepository: null,
    documentService: {
      async generateDocument(sessionId: string, approvedSuggestionIds: readonly string[]) {
        requested = { sessionId, approvedSuggestionIds };
        return {
          format: "pdf" as const,
          downloadPath: "/documents/4e4f8a8c-7c1f-4fa7-a5a5-83eb983437ea?token=signed-capability",
          expiresAt: new Date("2026-01-02T00:00:00.000Z"),
          created: true,
        };
      },
      async downloadDocument(sessionId: string, token: string) {
        downloaded = { sessionId, token };
        return Buffer.from("%PDF-test");
      },
      async deleteExpiredDocuments() { return 0; },
    },
  });
  context.after(() => app.close());

  const generated = await app.inject({
    method: "POST",
    url: "/sessions/4e4f8a8c-7c1f-4fa7-a5a5-83eb983437ea/documents",
    payload: { approvedSuggestionIds: ["experience-1"] },
  });
  const download = await app.inject({
    method: "GET",
    url: "/documents/4e4f8a8c-7c1f-4fa7-a5a5-83eb983437ea?token=signed-capability",
  });

  assert.equal(generated.statusCode, 201);
  assert.deepEqual(requested, {
    sessionId: "4e4f8a8c-7c1f-4fa7-a5a5-83eb983437ea",
    approvedSuggestionIds: ["experience-1"],
  });
  assert.deepEqual(generated.json(), {
    format: "pdf",
    downloadPath: "/documents/4e4f8a8c-7c1f-4fa7-a5a5-83eb983437ea?token=signed-capability",
    expiresAt: "2026-01-02T00:00:00.000Z",
  });
  assert.equal(download.statusCode, 200);
  assert.equal(download.headers["content-type"], "application/pdf");
  assert.equal(download.headers["cache-control"], "private, no-store, max-age=0");
  assert.equal(download.headers["referrer-policy"], "no-referrer");
  assert.equal(download.headers["content-disposition"], 'attachment; filename="curriculo.pdf"');
  assert.equal(download.body, "%PDF-test");
  assert.deepEqual(downloaded, {
    sessionId: "4e4f8a8c-7c1f-4fa7-a5a5-83eb983437ea",
    token: "signed-capability",
  });
});

test("rejects document payloads containing resume text and keeps generation gated on approved payment", async (context) => {
  let calls = 0;
  const app = createApp({
    analysisService: null,
    sessionRepository: null,
    documentService: {
      async generateDocument() {
        calls += 1;
        throw new DocumentServiceError("PAYMENT_NOT_APPROVED");
      },
      async downloadDocument() { return Buffer.from("pdf"); },
      async deleteExpiredDocuments() { return 0; },
    },
  });
  context.after(() => app.close());

  const invalid = await app.inject({
    method: "POST",
    url: "/sessions/4e4f8a8c-7c1f-4fa7-a5a5-83eb983437ea/documents",
    payload: { approvedSuggestionIds: [], resume: "forged resume" },
  });
  const unpaid = await app.inject({
    method: "POST",
    url: "/sessions/4e4f8a8c-7c1f-4fa7-a5a5-83eb983437ea/documents",
    payload: { approvedSuggestionIds: [] },
  });

  assert.equal(invalid.statusCode, 400);
  assert.equal(unpaid.statusCode, 409);
  assert.equal(unpaid.json().error.code, "PAYMENT_NOT_APPROVED");
  assert.equal(calls, 1);
});

test("does not serve a PDF without a bearer token", async (context) => {
  let calls = 0;
  const app = createApp({
    analysisService: null,
    sessionRepository: null,
    documentService: {
      async generateDocument() {
        return { format: "pdf" as const, downloadPath: "/", expiresAt: new Date(), created: true };
      },
      async downloadDocument() {
        calls += 1;
        return Buffer.from("pdf");
      },
      async deleteExpiredDocuments() { return 0; },
    },
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/documents/4e4f8a8c-7c1f-4fa7-a5a5-83eb983437ea",
  });

  assert.equal(response.statusCode, 404);
  assert.equal(calls, 0);
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
