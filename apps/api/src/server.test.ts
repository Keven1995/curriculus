import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { Writable } from "node:stream";
import test from "node:test";
import { createApp } from "./app.js";
import { AnalysisProviderError, InvalidAnalysisOutputError } from "./analyses/analysis-errors.js";
import { PixPaymentError } from "./payments/payment-errors.js";
import { PaymentWebhookError } from "./payments/payment-webhook-service.js";
import { DocumentServiceError } from "./documents/document-service.js";
import { DataDeletionServiceError } from "./privacy/data-deletion-service.js";
import type { CreateAnalysisSession } from "./persistence/session-repository.js";
import type { ResumeLayoutTemplate } from "./resume-layout/resume-layout-types.js";

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

test("enforces an IP-scoped request limit and returns a retry hint", async (context) => {
  const app = createApp({
    analysisService: null,
    sessionRepository: null,
    rateLimitPolicies: { global: { limit: 1, windowMs: 60_000 } },
  });
  context.after(() => app.close());

  const first = await app.inject({ method: "GET", url: "/health" });
  const limited = await app.inject({ method: "GET", url: "/health" });

  assert.equal(first.statusCode, 200);
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.headers["retry-after"], "60");
  assert.equal(limited.json().error.code, "RATE_LIMITED");
});

test("applies a tighter limit to expensive analysis requests", async (context) => {
  const app = createApp({
    analysisService: null,
    sessionRepository: null,
    rateLimitPolicies: { analysis: { limit: 1, windowMs: 60_000 } },
  });
  context.after(() => app.close());

  const first = await app.inject({ method: "POST", url: "/analyses", payload: {} });
  const second = await app.inject({ method: "POST", url: "/analyses", payload: {} });

  assert.equal(first.statusCode, 400);
  assert.equal(second.statusCode, 429);
  assert.equal(second.json().error.code, "RATE_LIMITED");
});

test("applies an independent daily per-IP analysis limit", async (context) => {
  let calls = 0;
  const app = createApp({
    rateLimitPolicies: { analysisDaily: { limit: 1, windowMs: 24 * 60 * 60_000 } },
    analysisService: {
      async analyze() {
        calls += 1;
        return {
          analysis: {
            jobRequirements: [],
            suggestions: [],
            documentStructure: { sectionOrder: [], suggestionOrder: [] },
          },
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: null },
        };
      },
    },
    sessionRepository: {
      async isReady() { return true; },
      async createSession() {
        return {
          id: "daily-limit-session",
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 60_000),
        };
      },
    } as never,
  });
  context.after(() => app.close());

  const first = await app.inject({ method: "POST", url: "/analyses", payload: validRequest });
  const second = await app.inject({ method: "POST", url: "/analyses", payload: validRequest });
  assert.equal(first.statusCode, 201);
  assert.equal(second.statusCode, 429);
  assert.equal(second.json().error.code, "RATE_LIMITED");
  assert.equal(calls, 1);
});

test("marks the full local test flow in analysis responses", async (context) => {
  const app = createApp({
    localTestMode: true,
    analysisService: {
      async analyze() {
        return {
          analysis: {
            jobRequirements: [],
            suggestions: [],
            documentStructure: { sectionOrder: [], suggestionOrder: [] },
          },
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: null },
        };
      },
    },
    sessionRepository: {
      async isReady() { return true; },
      async createSession() {
        return {
          id: "local-test-session",
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 60_000),
        };
      },
    } as never,
  });
  context.after(() => app.close());

  const response = await app.inject({ method: "POST", url: "/analyses", payload: validRequest });

  assert.equal(response.statusCode, 201);
  assert.equal(response.json().localTestMode, true);
});

test("exposes local layout import and accepts the original PDF as raw bytes", async (context) => {
  let importedBytes: Buffer | undefined;
  let importedName = "";
  const importPayload = Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(300_000, 1)]);
  const app = createApp({
    localTestMode: true,
    resumeLayoutService: {
      async importPdf(bytes, fileName) {
        importedBytes = bytes;
        importedName = fileName;
        return {
          templateId: "4e4f8a8c-7c1f-4fa7-a5a5-83eb983437ea",
          template: { id: "sidebar-dark-header-color-v1" },
          rawExtraction: { pages: [] },
          detectedSections: [],
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        } as never;
      },
      getTemplate() { return undefined; },
      discardTextExtraction() {},
      deleteTemplate() { return true; },
      clear() {},
    },
  });
  context.after(() => app.close());

  const capabilities = await app.inject({ method: "GET", url: "/features" });
  const imported = await app.inject({
    method: "POST",
    url: "/resume-layouts/import",
    headers: {
      "content-type": "application/pdf",
      "x-file-name": encodeURIComponent("referência.pdf"),
    },
    payload: importPayload,
  });
  assert.deepEqual(capabilities.json(), { resumeLayoutImport: true });
  assert.equal(imported.statusCode, 201);
  assert.ok(Buffer.isBuffer(importedBytes));
  assert.equal(importedBytes?.length, importPayload.length);
  assert.equal(importedName, "referência.pdf");
  assert.equal("rawExtraction" in imported.json(), false);
});

test("attaches only the server-extracted layout template to the analysis session", async (context) => {
  const templateId = "4e4f8a8c-7c1f-4fa7-a5a5-83eb983437ea";
  const template: ResumeLayoutTemplate = {
    schemaVersion: "2.0",
    id: "sidebar-dark-header-color-v1",
    page: { format: "A4", widthPt: 595.28, heightPt: 841.89, marginPt: 30 },
    palette: { sidebar: "#354550", main: "#FFFFFF", headerApprox: "#BACD9E", text: "#111111" },
    columns: { sidebarWidthPt: 170, gapPt: 20, sidebarRepeats: true },
    header: { heightPt: 140, nameUppercase: true },
    typography: { namePt: 26, sectionPt: 14, bodyPt: 10.5 },
    sections: ["summary", "experience", "education", "certifications"],
    sidebarSections: ["photo", "contact", "skills"],
    overflow: { wrapText: true, pageBreak: true, keepExperienceHeadingWithFirstBullet: true },
    detection: { confidence: 0.55, detectedColumns: 2, warnings: [] },
  };
  let storedInput: CreateAnalysisSession | undefined;
  let modelInput: Record<string, unknown> | undefined;
  const app = createApp({
    localTestMode: true,
    analysisService: {
      async analyze(input) {
        modelInput = input as unknown as Record<string, unknown>;
        return {
          analysis: { jobRequirements: [], suggestions: [], documentStructure: { sectionOrder: [], suggestionOrder: [] } },
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCostUsd: null },
        };
      },
    },
    sessionRepository: {
      async isReady() { return true; },
      async createSession(input) {
        storedInput = input;
        return { id: "session-with-layout", createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000) };
      },
    } as never,
    resumeLayoutService: {
      async importPdf() { throw new Error("not used in this test"); },
      getTemplate(id) { return id === templateId ? template : undefined; },
      discardTextExtraction() {},
      deleteTemplate() { return true; },
      clear() {},
    },
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/analyses",
    payload: { ...validRequest, resumeLayoutTemplateId: templateId },
  });

  assert.equal(response.statusCode, 201);
  assert.equal(response.json().usesReferenceLayout, true);
  assert.deepEqual(storedInput?.resumeLayoutTemplate, template);
  assert.equal("resumeLayoutTemplateId" in (modelInput ?? {}), false);
});

test("requires an explicit secure CORS origin in production and adds safe response headers", async (context) => {
  assert.throws(
    () => createApp({ analysisService: null, sessionRepository: null, production: true }),
    /WEB_ORIGIN/,
  );
  assert.throws(
    () => createApp({
      analysisService: null,
      sessionRepository: null,
      production: true,
      webOrigin: "https://curriculus.example",
      localTestMode: true,
    }),
    /Local test mode must never be enabled in production/,
  );
  assert.throws(
    () => createApp({
      analysisService: null,
      sessionRepository: null,
      production: true,
      webOrigin: "https://curriculus.example",
      resumeLayoutService: { importPdf: async () => ({} as never), getTemplate: () => undefined, discardTextExtraction: () => {}, deleteTemplate: () => true, clear: () => {} },
    }),
    /Local resume layout import must never be enabled in production/,
  );
  const app = createApp({
    analysisService: null,
    sessionRepository: null,
    production: true,
    webOrigin: "https://curriculus.example",
  });
  context.after(() => app.close());

  const allowed = await app.inject({
    method: "GET",
    url: "/health",
    headers: { origin: "https://curriculus.example" },
  });
  const denied = await app.inject({
    method: "GET",
    url: "/health",
    headers: { origin: "https://attacker.example" },
  });
  const preflight = await app.inject({
    method: "OPTIONS",
    url: "/sessions/4e4f8a8c-7c1f-4fa7-a5a5-83eb983437ea/data",
    headers: {
      origin: "https://curriculus.example",
      "access-control-request-method": "DELETE",
      "access-control-request-headers": "authorization,content-type",
    },
  });

  assert.equal(allowed.headers["access-control-allow-origin"], "https://curriculus.example");
  assert.equal(denied.headers["access-control-allow-origin"], undefined);
  assert.equal(preflight.headers["access-control-allow-origin"], "https://curriculus.example");
  assert.match(preflight.headers["access-control-allow-methods"] ?? "", /DELETE/);
  assert.equal(allowed.headers["x-content-type-options"], "nosniff");
  assert.equal(allowed.headers["x-frame-options"], "DENY");
  assert.equal(allowed.headers["referrer-policy"], "no-referrer");
  assert.match(String(allowed.headers["content-security-policy"]), /default-src 'none'/);
});

test("rejects an unsafe configured reverse-proxy hop count", () => {
  assert.throws(
    () => createApp({ analysisService: null, sessionRepository: null, trustedProxyHops: 6 }),
    /TRUST_PROXY_HOPS/,
  );
});

test("protects metrics with a strong bearer secret and uses only bounded route labels", async (context) => {
  const secret = "metrics-secret-with-at-least-32-random-bytes";
  const app = createApp({
    analysisService: null,
    sessionRepository: null,
    metricsToken: secret,
    dataDeletionService: { async deleteSessionData() { return "deleted" as const; } },
  });
  context.after(() => app.close());

  const sessionId = "4e4f8a8c-7c1f-4fa7-a5a5-83eb983437ea";
  await app.inject({ method: "DELETE", url: `/sessions/${sessionId}/data?email=private@example.test` });
  const unauthorized = await app.inject({ method: "GET", url: "/metrics" });
  const metrics = await app.inject({
    method: "GET",
    url: "/metrics",
    headers: { authorization: `Bearer ${secret}` },
  });

  assert.equal(unauthorized.statusCode, 404);
  assert.equal(metrics.statusCode, 200);
  assert.match(metrics.headers["content-type"] ?? "", /text\/plain/);
  assert.match(metrics.body, /route="\/sessions\/:sessionId\/data"/);
  assert.equal(metrics.body.includes(sessionId), false);
  assert.equal(metrics.body.includes("private@example.test"), false);
});

test("deletes a session's data through an idempotent, bodyless endpoint", async (context) => {
  let deletedSessionId = "";
  const app = createApp({
    analysisService: null,
    sessionRepository: null,
    dataDeletionService: {
      async deleteSessionData(sessionId: string) {
        deletedSessionId = sessionId;
        return "deleted" as const;
      },
    },
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: "DELETE",
    url: "/sessions/4e4f8a8c-7c1f-4fa7-a5a5-83eb983437ea/data",
  });

  assert.equal(response.statusCode, 204);
  assert.equal(response.body, "");
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(deletedSessionId, "4e4f8a8c-7c1f-4fa7-a5a5-83eb983437ea");
});

test("maps unavailable deletion storage to a safe retryable response", async (context) => {
  const app = createApp({
    analysisService: null,
    sessionRepository: null,
    dataDeletionService: {
      async deleteSessionData() {
        throw new DataDeletionServiceError("DOCUMENT_STORAGE_UNAVAILABLE");
      },
    },
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: "DELETE",
    url: "/sessions/4e4f8a8c-7c1f-4fa7-a5a5-83eb983437ea/data",
  });

  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, "DOCUMENT_STORAGE_UNAVAILABLE");
  assert.equal(response.body.includes("4e4f8a8c"), false);
});

test("does not report deletion success if a pending Pix cancellation cannot be confirmed", async (context) => {
  const app = createApp({
    analysisService: null,
    sessionRepository: null,
    dataDeletionService: {
      async deleteSessionData() {
        throw new DataDeletionServiceError("PAYMENT_CANCELLATION_UNAVAILABLE");
      },
    },
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: "DELETE",
    url: "/sessions/4e4f8a8c-7c1f-4fa7-a5a5-83eb983437ea/data",
  });

  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), {
    error: {
      code: "PAYMENT_CANCELLATION_UNAVAILABLE",
      message: "Não foi possível cancelar a cobrança Pix. Seus dados não foram excluídos; tente novamente.",
    },
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

test("logs safe provider diagnostics while keeping secrets and submitted text out of logs and responses", async (context) => {
  const logLines: string[] = [];
  const logStream = new Writable({
    write(chunk, _encoding, callback) {
      logLines.push(String(chunk));
      callback();
    },
  });
  const app = createApp({
    logger: { level: "warn", stream: logStream },
    analysisService: {
      async analyze() {
        throw new AnalysisProviderError({
          reason: "authentication_failed",
          httpStatus: 401,
          requestId: "req_safe-id-123",
        });
      },
    },
    sessionRepository: { async isReady() { return true; } } as never,
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/analyses",
    payload: {
      jobDescription: "PRIVATE_JOB_DESCRIPTION",
      resume: "PRIVATE_RESUME_CONTENT",
      dataNoticeAcknowledged: true,
    },
  });
  const logs = logLines.join("");

  assert.equal(response.statusCode, 502);
  assert.deepEqual(response.json().error, {
    code: "ANALYSIS_PROVIDER_ERROR",
    message: "Não foi possível concluir a análise. Tente novamente mais tarde.",
  });
  assert.match(logs, /"providerFailure":"authentication_failed"/);
  assert.match(logs, /"providerStatusCode":401/);
  assert.match(logs, /"providerRequestId":"req_safe-id-123"/);
  assert.equal(logs.includes("PRIVATE_JOB_DESCRIPTION"), false);
  assert.equal(logs.includes("PRIVATE_RESUME_CONTENT"), false);
  assert.equal(response.body.includes("authentication_failed"), false);
});

test("returns a friendly temporary-unavailability response for Gemini quota exhaustion", async (context) => {
  const app = createApp({
    analysisService: {
      async analyze() {
        throw new AnalysisProviderError({ provider: "gemini", reason: "quota_exhausted", httpStatus: 429 });
      },
    },
    sessionRepository: { async isReady() { return true; } } as never,
  });
  context.after(() => app.close());

  const response = await app.inject({ method: "POST", url: "/analyses", payload: validRequest });
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json().error, {
    code: "ANALYSIS_PROVIDER_ERROR",
    message: "Análises temporariamente indisponíveis. Tente novamente mais tarde.",
  });
});

test("logs only a safe validation failure code when model output is rejected", async (context) => {
  const logLines: string[] = [];
  const logStream = new Writable({
    write(chunk, _encoding, callback) {
      logLines.push(String(chunk));
      callback();
    },
  });
  const app = createApp({
    logger: { level: "warn", stream: logStream },
    analysisService: {
      async analyze() {
        throw new InvalidAnalysisOutputError("invalid_collections");
      },
    },
    sessionRepository: { async isReady() { return true; } } as never,
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/analyses",
    payload: {
      jobDescription: "PRIVATE_JOB_DESCRIPTION",
      resume: "PRIVATE_RESUME_CONTENT",
      dataNoticeAcknowledged: true,
    },
  });
  const logs = logLines.join("");

  assert.equal(response.statusCode, 502);
  assert.match(logs, /"validationFailure":"invalid_collections"/);
  assert.equal(logs.includes("PRIVATE_JOB_DESCRIPTION"), false);
  assert.equal(logs.includes("PRIVATE_RESUME_CONTENT"), false);
  assert.equal(response.body.includes("invalid_collections"), false);
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
