import { createHmac } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../src/app.js";
import { createConfiguredAnalysisService } from "../src/analyses/configured-analysis-service.js";
import PDFDocument from "pdfkit";
import { DocumentService } from "../src/documents/document-service.js";
import { PrivateFileDocumentStorage } from "../src/documents/private-file-document-storage.js";
import { DataDeletionService } from "../src/privacy/data-deletion-service.js";
import { PaymentWebhookService } from "../src/payments/payment-webhook-service.js";
import type { PixPaymentProvider } from "../src/payments/pix-payment-provider.js";
import { PixPaymentService } from "../src/payments/pix-payment-service.js";
import type { ProviderPaymentDetails } from "../src/payments/payment-status-provider.js";
import { EphemeralSessionRepository } from "./ephemeral-session-repository.js";

const E2E_WEBHOOK_SECRET = "local-e2e-webhook-secret-only-not-for-deployment";
const DOCUMENT_SECRET = "local-e2e-document-secret-only-not-for-deployment";
const e2eRunId = process.env.CURRICULUS_E2E_RUN_ID;

if (
  process.env.CURRICULUS_E2E !== "true" ||
  process.env.NODE_ENV === "production" ||
  !e2eRunId ||
  !/^[0-9a-f-]{36}$/i.test(e2eRunId)
) {
  throw new Error("The E2E server can only run explicitly in a non-production test environment.");
}

class E2ePaymentProvider implements PixPaymentProvider {
  private readonly payments = new Map<string, ProviderPaymentDetails>();
  private sequence = 0;
  receivedPayerEmailCount = 0;

  async createPixPayment(input: Parameters<PixPaymentProvider["createPixPayment"]>[0]): Promise<{
    providerPaymentId: string;
    qrCode: string;
    qrCodeBase64: string;
  }> {
    if (input.payerEmail) this.receivedPayerEmailCount += 1;
    const paymentId = `e2e-payment-${++this.sequence}`;
    this.payments.set(paymentId, {
      paymentId,
      status: "pending",
      transactionAmount: input.amountCents / 100,
      currency: input.currency,
      externalReference: input.orderId,
      paymentMethodId: "pix",
      dateApproved: null,
    });
    return {
      providerPaymentId: paymentId,
      qrCode: "000201-e2e-pix-copy-and-paste",
      qrCodeBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    };
  }

  async getPaymentDetails(paymentId: string): Promise<ProviderPaymentDetails> {
    const payment = this.payments.get(paymentId);
    if (!payment) throw new Error("Unknown local E2E payment.");
    return payment;
  }

  async cancelPendingPayment(paymentId: string, expectedOrderId: string): Promise<"cancelled" | "approved"> {
    const payment = await this.getPaymentDetails(paymentId);
    if (payment.externalReference !== expectedOrderId) throw new Error("Unexpected local E2E order.");
    if (payment.status === "approved") return "approved";
    this.payments.set(paymentId, { ...payment, status: "cancelled" });
    return "cancelled";
  }

  approve(paymentId: string): void {
    const payment = this.payments.get(paymentId);
    if (!payment) throw new Error("Unknown local E2E payment.");
    this.payments.set(paymentId, { ...payment, status: "approved", dateApproved: new Date() });
  }
}

const repository = new EphemeralSessionRepository();
const paymentProvider = new E2ePaymentProvider();
const analysisService = createConfiguredAnalysisService({
  NODE_ENV: "test",
  AI_ANALYSIS_ENABLED: "true",
  AI_PROVIDER: "mock",
} as NodeJS.ProcessEnv);
if (!analysisService) throw new Error("The E2E fixture analysis provider failed to configure.");
const documentDirectory = join(tmpdir(), `curriculus-e2e-${e2eRunId}`);
await mkdir(documentDirectory, { recursive: true });
process.once("exit", () => {
  try {
    rmSync(documentDirectory, { recursive: true, force: true });
  } catch {
    // The Playwright global teardown retries cleanup if the process exits abruptly.
  }
});
const storage = new PrivateFileDocumentStorage(documentDirectory);
const documentService = new DocumentService(repository, storage, DOCUMENT_SECRET);
const paymentWebhook = new PaymentWebhookService(repository, paymentProvider);
const resumeFixturePdf = await new Promise<Buffer>((resolve, reject) => {
  const pdf = new PDFDocument({ size: "A4" });
  const chunks: Buffer[] = [];
  pdf.on("data", (chunk: Buffer) => chunks.push(chunk));
  pdf.once("error", reject);
  pdf.once("end", () => resolve(Buffer.concat(chunks)));
  pdf.font("Helvetica").fontSize(11).text("Trabalhei com Java para construir APIs REST. Tenho experiencia com documentacao tecnica.");
  pdf.end();
});
const app = createApp({
  production: false,
  webOrigin: "http://127.0.0.1:4173",
  analysisService,
  sessionRepository: repository,
  pixPaymentService: new PixPaymentService(repository, paymentProvider),
  paymentWebhook: { secret: E2E_WEBHOOK_SECRET, service: paymentWebhook },
  documentService,
  dataDeletionService: new DataDeletionService(repository, storage, paymentProvider),
});

app.addHook("onClose", async () => rm(documentDirectory, { recursive: true, force: true }));

app.get("/__e2e/resume-fixture.pdf", async (_request, reply) =>
  reply
    .header("content-type", "application/pdf")
    .header("cache-control", "no-store")
    .send(resumeFixturePdf),
);

app.post<{ Body: { sessionId?: string } }>("/__e2e/approve", async (request, reply) => {
  const sessionId = request.body?.sessionId;
  if (typeof sessionId !== "string") return reply.status(400).send({ error: "INVALID_SESSION" });
  const order = await repository.findOrderBySessionId(sessionId);
  if (!order?.providerPaymentId) return reply.status(404).send({ error: "PAYMENT_NOT_FOUND" });

  paymentProvider.approve(order.providerPaymentId);
  const timestamp = String(Date.now());
  const requestId = "local-e2e-request-1";
  const manifest = `id:${order.providerPaymentId.toLowerCase()};request-id:${requestId};ts:${timestamp};`;
  const digest = createHmac("sha256", E2E_WEBHOOK_SECRET).update(manifest).digest("hex");
  const webhook = await app.inject({
    method: "POST",
    url: `/webhooks/mercadopago?type=payment&data.id=${encodeURIComponent(order.providerPaymentId)}`,
    headers: {
      "x-request-id": requestId,
      "x-signature": `ts=${timestamp},v1=${digest}`,
    },
    payload: { type: "payment", data: { id: order.providerPaymentId } },
  });
  if (webhook.statusCode !== 200) return reply.status(502).send({ error: "LOCAL_WEBHOOK_FAILED" });
  return reply.status(200).send({ approved: true });
});

app.get<{ Params: { sessionId: string } }>("/__e2e/inspect/:sessionId", async (request) => {
  const { sessionId } = request.params;
  const entry = repository.sessions.get(sessionId);
  const order = await repository.findOrderBySessionId(sessionId);
  const financialOrderId = repository.orderIdsBySession.get(sessionId);
  const financialOrder = financialOrderId ? await repository.findOrder(financialOrderId) : null;
  return {
    analysisActive: Boolean(entry?.analysis),
    documentActive: Boolean(entry?.document),
    orderStatus: order?.status ?? financialOrder?.status ?? null,
    payerEmailSentToProvider: paymentProvider.receivedPayerEmailCount > 0,
    payerEmailPersisted: [...repository.orders.values()].some((candidate) => "payerEmail" in candidate),
  };
});

const port = Number(process.env.PORT ?? "4174");
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error("The local E2E API port is invalid.");
}
await app.listen({ host: "127.0.0.1", port });

const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
