import { randomBytes, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../src/app.js";
import { createConfiguredAnalysisService } from "../src/analyses/configured-analysis-service.js";
import { validateDocumentRequest } from "../src/documents/document-request.js";
import { DocumentService, DocumentServiceError } from "../src/documents/document-service.js";
import { PrivateFileDocumentStorage } from "../src/documents/private-file-document-storage.js";
import { PaymentWebhookService } from "../src/payments/payment-webhook-service.js";
import type { PaymentStatusProvider, ProviderPaymentDetails } from "../src/payments/payment-status-provider.js";
import type { PendingPaymentCancellationProvider } from "../src/payments/pending-payment-cancellation-provider.js";
import type { CreatePixPaymentInput, PixPaymentProvider } from "../src/payments/pix-payment-provider.js";
import { PixPaymentService } from "../src/payments/pix-payment-service.js";
import { DataDeletionService } from "../src/privacy/data-deletion-service.js";
import { EphemeralSessionRepository } from "./ephemeral-session-repository.js";
import { InMemoryRateLimiter } from "../src/security/in-memory-rate-limiter.js";
import { ResumeLayoutService } from "../src/resume-layout/resume-layout-service.js";

const LOCAL_WEB_ORIGIN = "http://127.0.0.1:3000";
const LOCAL_TEST_EMAIL = "no-email-sent@curriculus.invalid";

if (process.env.NODE_ENV === "production") {
  throw new Error("The local test server must never run with NODE_ENV=production.");
}

if (!process.env.NODE_ENV) process.env.NODE_ENV = "development";
const { loadEnvironmentFiles } = await import("../src/load-environment.js");
loadEnvironmentFiles();
if (process.env.NODE_ENV === "production") {
  throw new Error("The local test server must never run with NODE_ENV=production.");
}

const analysisService = createConfiguredAnalysisService();
if (!analysisService) {
  throw new Error("Configure AI_ANALYSIS_ENABLED and a valid AI_PROVIDER in the backend .env before starting local test mode.");
}

class LocalTestPaymentProvider implements
  PixPaymentProvider,
  PaymentStatusProvider,
  PendingPaymentCancellationProvider {
  private readonly payments = new Map<string, ProviderPaymentDetails>();
  private sequence = 0;

  async createPixPayment(input: CreatePixPaymentInput) {
    const paymentId = `local-test-payment-${++this.sequence}`;
    this.payments.set(paymentId, {
      paymentId,
      status: "pending",
      transactionAmount: input.amountCents / 100,
      currency: input.currency,
      externalReference: input.orderId,
      paymentMethodId: "pix",
      dateApproved: null,
    });
    // Values satisfy the internal payment contract only. They are never sent to a payment provider or shown as a real Pix.
    return {
      providerPaymentId: paymentId,
      qrCode: "LOCAL TEST ONLY - NO PIX PAYMENT",
      qrCodeBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    };
  }

  async getPaymentDetails(paymentId: string): Promise<ProviderPaymentDetails> {
    const payment = this.payments.get(paymentId);
    if (!payment) throw new Error("Unknown local test payment.");
    return payment;
  }

  async cancelPendingPayment(paymentId: string, expectedOrderId: string): Promise<"cancelled" | "approved"> {
    const payment = await this.getPaymentDetails(paymentId);
    if (payment.externalReference !== expectedOrderId) throw new Error("Unexpected local test order.");
    if (payment.status === "approved") return "approved";
    this.payments.set(paymentId, { ...payment, status: "cancelled" });
    return "cancelled";
  }

  approveOrder(orderId: string): string | undefined {
    for (const [paymentId, payment] of this.payments) {
      if (payment.externalReference !== orderId) continue;
      this.payments.set(paymentId, {
        ...payment,
        status: "approved",
        dateApproved: new Date(),
      });
      return paymentId;
    }
    return undefined;
  }
}

process.env.TRUST_PROXY_HOPS = "0";
const repository = new EphemeralSessionRepository();
const paymentProvider = new LocalTestPaymentProvider();
const paymentService = new PixPaymentService(repository, paymentProvider);
const paymentWebhookService = new PaymentWebhookService(repository, paymentProvider);
const documentDirectory = join(tmpdir(), `curriculus-local-test-${randomUUID()}`);
await mkdir(documentDirectory, { recursive: true });
const storage = new PrivateFileDocumentStorage(documentDirectory);
const documentService = new DocumentService(
  repository,
  storage,
  randomBytes(32).toString("base64url"),
);
const paymentWebhookSecret = randomBytes(32).toString("base64url");
const localDocumentLimiter = new InMemoryRateLimiter();
const resumeLayoutService = new ResumeLayoutService();

process.once("exit", () => {
  try {
    rmSync(documentDirectory, { recursive: true, force: true });
  } catch {
    // The OS temp-directory cleanup is a second safety net for an interrupted local process.
  }
});

const app = createApp({
  production: false,
  webOrigin: LOCAL_WEB_ORIGIN,
  trustedProxyHops: 0,
  localTestMode: true,
  resumeLayoutService,
  analysisService,
  sessionRepository: repository,
  pixPaymentService: paymentService,
  paymentWebhook: { secret: paymentWebhookSecret, service: paymentWebhookService },
  documentService,
  dataDeletionService: new DataDeletionService(repository, storage, paymentProvider),
  logger: true,
});

app.post<{ Params: { sessionId: string }; Body: unknown }>(
  "/__local-test/sessions/:sessionId/documents",
  {
    onRequest: async (request, reply) => {
      const decision = localDocumentLimiter.consume("local-test-document", request.ip, {
        limit: 10,
        windowMs: 15 * 60_000,
      });
      if (!decision.allowed) {
        reply.header("retry-after", String(decision.retryAfterSeconds));
        return reply.status(429).send({
          error: { code: "RATE_LIMITED", message: "Muitas solicitações. Aguarde antes de tentar novamente." },
        });
      }
    },
  },
  async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (request.headers.origin !== LOCAL_WEB_ORIGIN) {
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Rota não encontrada." } });
    }

    const validation = validateDocumentRequest(request.body);
    if (!validation.success) {
      return reply.status(400).send({
        error: {
          code: "INVALID_DOCUMENT_REQUEST",
          message: "Envie somente os identificadores das sugestões aprovadas.",
        },
      });
    }

    try {
      const existingDocument = await repository.findGeneratedDocument(request.params.sessionId);
      if (!existingDocument) {
        const existingOrder = await repository.findOrderBySessionId(request.params.sessionId);
        if (existingOrder?.status !== "approved") {
          const payment = await paymentService.createPixPayment(request.params.sessionId, LOCAL_TEST_EMAIL);
          const paymentId = paymentProvider.approveOrder(payment.orderId);
          if (!paymentId) throw new Error("Local test payment could not be approved.");
          await paymentWebhookService.handlePaymentNotification(paymentId);
        }
      }

      const document = await documentService.generateDocument(
        request.params.sessionId,
        validation.data.approvedSuggestionIds,
      );
      return reply
        .header("referrer-policy", "no-referrer")
        .status(document.created ? 201 : 200)
        .send({
          format: document.format,
          downloadPath: document.downloadPath,
          expiresAt: document.expiresAt,
        });
    } catch (error) {
      const reason = error instanceof DocumentServiceError ? error.code : "local_test_failure";
      request.log.warn({ event: "local_test_document_failed", reason }, "Local test PDF generation failed");
      return reply.status(503).send({
        error: {
          code: "LOCAL_TEST_DOCUMENT_FAILED",
          message: "Não foi possível gerar o PDF de teste local. Gere uma nova análise e tente novamente.",
        },
      });
    }
  },
);

const cleanupTimer = setInterval(() => {
  void repository.deleteExpiredSessions();
  void documentService.deleteExpiredDocuments();
}, 15 * 60_000);
cleanupTimer.unref();
const layoutCleanupTimer = setInterval(() => resumeLayoutService.cleanupExpired(), 60_000);
layoutCleanupTimer.unref();
app.addHook("onClose", async () => {
  clearInterval(cleanupTimer);
  clearInterval(layoutCleanupTimer);
  await rm(documentDirectory, { recursive: true, force: true });
});

const port = Number(process.env.PORT ?? "4000");
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error("The local test API port must be an integer between 1024 and 65535.");
}

await app.listen({ host: "127.0.0.1", port });
app.log.info(
  { event: "local_test_server_started", host: "127.0.0.1", port },
  "Local full-flow test server started; payments are simulated and no external payment provider is used",
);

const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
