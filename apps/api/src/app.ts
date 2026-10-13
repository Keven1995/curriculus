import cors from "@fastify/cors";
import Fastify, { LogController, type FastifyInstance } from "fastify";
import {
  ANALYSIS_REQUEST_LIMITS,
  validateAnalysisRequest,
  type AnalysisRequestIssue,
} from "./analyses/analysis-request.js";
import {
  AnalysisInputTokenLimitError,
  AnalysisProviderError,
  AnalysisUsageLimitError,
  InvalidAnalysisOutputError,
  JobDescriptionRequiredError,
} from "./analyses/analysis-errors.js";
import { createConfiguredAnalysisService } from "./analyses/configured-analysis-service.js";
import type { AnalysisService } from "./analyses/analysis-service.js";
import { createConfiguredSessionRepository } from "./persistence/postgres-session-repository.js";
import type { SessionRepository } from "./persistence/session-repository.js";
import { validatePixPaymentRequest } from "./payments/payment-request.js";
import { PixPaymentError } from "./payments/payment-errors.js";
import { createConfiguredPixPaymentService } from "./payments/configured-pix-payment-service.js";
import type { PixPaymentServiceContract } from "./payments/pix-payment-service.js";
import {
  createConfiguredPaymentWebhook,
  type PaymentWebhookEndpoint,
} from "./payments/configured-payment-webhook.js";
import { verifyMercadoPagoWebhookSignature } from "./payments/mercadopago-webhook-signature.js";
import { PaymentWebhookError } from "./payments/payment-webhook-service.js";
import { createConfiguredDocumentService } from "./documents/configured-document-service.js";
import { validateDocumentRequest } from "./documents/document-request.js";
import { DocumentServiceError, type DocumentService } from "./documents/document-service.js";

type AppOptions = {
  webOrigin?: string;
  logger?: boolean;
  analysisService?: AnalysisService | null;
  sessionRepository?: SessionRepository | null;
  pixPaymentService?: PixPaymentServiceContract | null;
  paymentWebhook?: PaymentWebhookEndpoint | null;
  documentService?: Pick<DocumentService, "generateDocument" | "downloadDocument" | "deleteExpiredDocuments"> | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const issueMessages: Record<AnalysisRequestIssue["code"], string> = {
  invalid_type: "O formato de um ou mais campos é inválido.",
  required: "Preencha os campos obrigatórios.",
  too_long: "Um ou mais campos excedem o limite de tamanho permitido.",
  invalid_url: "Informe um link válido iniciado por http:// ou https://.",
  unknown_field: "A requisição contém campos não reconhecidos.",
};

export function createApp(options: AppOptions = {}): FastifyInstance {
  const analysisService =
    options.analysisService === undefined
      ? createConfiguredAnalysisService()
      : options.analysisService ?? undefined;
  const sessionRepository =
    options.sessionRepository === undefined
      ? createConfiguredSessionRepository()
      : options.sessionRepository ?? undefined;
  const pixPaymentService =
    options.pixPaymentService === undefined
      ? sessionRepository
        ? createConfiguredPixPaymentService(sessionRepository)
        : undefined
      : options.pixPaymentService ?? undefined;
  const paymentWebhook =
    options.paymentWebhook === undefined
      ? sessionRepository
        ? createConfiguredPaymentWebhook(sessionRepository)
        : undefined
      : options.paymentWebhook ?? undefined;
  const documentService =
    options.documentService === undefined
      ? sessionRepository
        ? createConfiguredDocumentService(sessionRepository)
        : undefined
      : options.documentService ?? undefined;
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: ANALYSIS_REQUEST_LIMITS.bodyBytes,
    logController: new LogController({ disableRequestLogging: true }),
  });

  void app.register(cors, {
    origin: options.webOrigin ?? process.env.WEB_ORIGIN ?? "http://localhost:3000",
  });

  if (sessionRepository && options.sessionRepository === undefined) {
    let cleanupTimer: NodeJS.Timeout | undefined;
    const cleanupExpiredSessions = async () => {
      try {
        const deletedCount = await sessionRepository.deleteExpiredSessions();
        if (deletedCount > 0) {
          app.log.info({ event: "expired_sessions_deleted", deletedCount }, "Expired sessions removed");
        }
      } catch {
        app.log.warn({ event: "session_expiry_cleanup_failed" }, "Session cleanup failed");
      }
    };
    const cleanupExpiredDocuments = async () => {
      if (!documentService) return;
      try {
        const deletedCount = await documentService.deleteExpiredDocuments();
        if (deletedCount > 0) {
          app.log.info({ event: "expired_documents_deleted", deletedCount }, "Expired documents removed");
        }
      } catch {
        app.log.warn({ event: "document_expiry_cleanup_failed" }, "Document cleanup failed");
      }
    };

    app.addHook("onReady", async () => {
      await cleanupExpiredSessions();
      await cleanupExpiredDocuments();
      cleanupTimer = setInterval(() => {
        void cleanupExpiredSessions();
        void cleanupExpiredDocuments();
      }, 15 * 60 * 1000);
      cleanupTimer.unref();
    });
    app.addHook("onClose", async () => {
      if (cleanupTimer) clearInterval(cleanupTimer);
      await sessionRepository.close?.();
    });
  }

  app.setErrorHandler((error, _request, reply) => {
    const statusCode =
      typeof error === "object" && error !== null && "statusCode" in error
        ? error.statusCode
        : undefined;

    if (statusCode === 413) {
      return reply.status(413).send({
        error: {
          code: "PAYLOAD_TOO_LARGE",
          message: "A requisição excede o limite de 256 KiB.",
        },
      });
    }

    if (statusCode === 400) {
      return reply.status(400).send({
        error: {
          code: "INVALID_JSON",
          message: "Não foi possível interpretar o corpo da requisição.",
        },
      });
    }

    if (statusCode === 415) {
      return reply.status(415).send({
        error: {
          code: "UNSUPPORTED_MEDIA_TYPE",
          message: "Envie a requisição como application/json.",
        },
      });
    }

    return reply.status(500).send({
      error: {
        code: "INTERNAL_ERROR",
        message: "Não foi possível processar a requisição.",
      },
    });
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).send({
      error: { code: "NOT_FOUND", message: "Rota não encontrada." },
    }),
  );

  app.get("/health", async () => ({ status: "ok", service: "curriculus-api" }));

  app.post("/analyses", async (request, reply) => {
    const validation = validateAnalysisRequest(request.body);

    if (!validation.success) {
      return reply.status(400).send({
        error: {
          code: "INVALID_REQUEST",
          message: "Os dados enviados são inválidos.",
          fields: validation.issues.map((issue) => ({
            field: issue.field,
            code: issue.code,
            message: issueMessages[issue.code],
          })),
        },
      });
    }

    if (!validation.data.jobDescription) {
      return reply.status(422).send({
        error: {
          code: "JOB_DESCRIPTION_REQUIRED",
          message: "Cole a descrição da vaga; a leitura automática do link ainda não está disponível.",
        },
      });
    }

    if (!analysisService) {
      return reply.status(503).send({
        error: {
          code: "ANALYSIS_NOT_CONFIGURED",
          message: "A análise ainda não está configurada neste ambiente.",
        },
      });
    }

    if (!sessionRepository) {
      return reply.status(503).send({
        error: {
          code: "PERSISTENCE_NOT_CONFIGURED",
          message: "O armazenamento temporário ainda não está configurado neste ambiente.",
        },
      });
    }

    if (!(await sessionRepository.isReady())) {
      return reply.status(503).send({
        error: {
          code: "PERSISTENCE_UNAVAILABLE",
          message: "O armazenamento temporário não está disponível neste momento.",
        },
      });
    }

    try {
      const result = await analysisService.analyze(validation.data);
      const session = await sessionRepository.createSession({
        jobUrl: validation.data.jobUrl,
        jobDescription: validation.data.jobDescription,
        resume: validation.data.resume,
        analysis: result.analysis,
        usage: result.usage,
      });
      request.log.info(
        {
          event: "analysis_completed",
          sessionId: session.id,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          totalTokens: result.usage.totalTokens,
          estimatedCostUsd: result.usage.estimatedCostUsd,
        },
        "Curriculus analysis completed",
      );
      return reply.status(201).send({
        sessionId: session.id,
        expiresAt: session.expiresAt,
        ...result,
      });
    } catch (error) {
      if (error instanceof JobDescriptionRequiredError) {
        return reply.status(422).send({
          error: {
            code: "JOB_DESCRIPTION_REQUIRED",
            message: "Cole a descrição da vaga; a leitura automática do link ainda não está disponível.",
          },
        });
      }

      if (error instanceof AnalysisInputTokenLimitError) {
        return reply.status(413).send({
          error: {
            code: "INPUT_TOKEN_LIMIT_EXCEEDED",
            message: "O conteúdo excede o limite de tokens por análise.",
            maximumTokens: error.maximumTokens,
          },
        });
      }

      if (error instanceof AnalysisProviderError) {
        request.log.warn({ event: "analysis_failed", reason: "provider_error" }, "Analysis provider failed");
        return reply.status(502).send({
          error: {
            code: "ANALYSIS_PROVIDER_ERROR",
            message: "Não foi possível concluir a análise. Tente novamente mais tarde.",
          },
        });
      }

      if (error instanceof InvalidAnalysisOutputError) {
        request.log.warn({ event: "analysis_failed", reason: "invalid_model_output" }, "Analysis output rejected");
        return reply.status(502).send({
          error: {
            code: "INVALID_ANALYSIS_OUTPUT",
            message: "A análise não pôde ser validada. Nenhuma sugestão foi liberada.",
          },
        });
      }

      if (error instanceof AnalysisUsageLimitError) {
        request.log.error({ event: "analysis_failed", reason: "usage_limit_exceeded" }, "Analysis usage limit exceeded");
        return reply.status(502).send({
          error: {
            code: "ANALYSIS_USAGE_LIMIT_EXCEEDED",
            message: "A análise excedeu um limite interno e não foi liberada.",
          },
        });
      }

      request.log.error({ event: "analysis_failed", reason: "unexpected_error" }, "Analysis failed");
      return reply.status(500).send({
        error: {
          code: "ANALYSIS_FAILED",
          message: "Não foi possível processar a análise.",
        },
      });
    }
  });

  app.post<{ Params: { sessionId: string } }>("/sessions/:sessionId/payments/pix", async (request, reply) => {
    const validation = validatePixPaymentRequest(request.body);
    if (!validation.success) {
      return reply.status(400).send({
        error: {
          code: "INVALID_REQUEST",
          message: "Informe um e-mail válido para gerar o Pix.",
          fields: validation.issues.map((issue) => ({ field: issue.field, code: issue.code })),
        },
      });
    }

    if (!pixPaymentService) {
      return reply.status(503).send({
        error: {
          code: "PAYMENT_NOT_CONFIGURED",
          message: "O pagamento Pix ainda não está habilitado neste ambiente.",
        },
      });
    }
    if (!documentService) {
      return reply.status(503).send({
        error: {
          code: "DOCUMENT_NOT_CONFIGURED",
          message: "O armazenamento privado do currículo final não está configurado.",
        },
      });
    }

    try {
      const payment = await pixPaymentService.createPixPayment(
        request.params.sessionId,
        validation.data.payerEmail,
      );
      return reply.status(201).send(payment);
    } catch (error) {
      if (error instanceof PixPaymentError) {
        const failure: Record<
          PixPaymentError["code"],
          { statusCode: number; message: string }
        > = {
          PERSISTENCE_UNAVAILABLE: {
            statusCode: 503,
            message: "O armazenamento temporário não está disponível neste momento.",
          },
          SESSION_NOT_PAYABLE: {
            statusCode: 404,
            message: "A sessão não foi encontrada ou expirou.",
          },
          ORDER_NOT_PENDING: {
            statusCode: 409,
            message: "Este pedido não aceita uma nova cobrança.",
          },
          CHECKOUT_WINDOW_TOO_SHORT: {
            statusCode: 409,
            message: "A sessão está próxima do vencimento. Gere uma nova análise para continuar.",
          },
          PROVIDER_UNAVAILABLE: {
            statusCode: 502,
            message: "Não foi possível gerar o Pix. Tente novamente mais tarde.",
          },
        };
        const mapped = failure[error.code];
        request.log.warn({ event: "pix_payment_failed", reason: error.code }, "Pix payment request failed");
        return reply.status(mapped.statusCode).send({
          error: { code: error.code, message: mapped.message },
        });
      }

      request.log.error({ event: "pix_payment_failed", reason: "unexpected_error" }, "Pix payment request failed");
      return reply.status(500).send({
        error: {
          code: "PAYMENT_FAILED",
          message: "Não foi possível processar a cobrança Pix.",
        },
      });
    }
  });

  app.get<{ Params: { sessionId: string } }>("/sessions/:sessionId/payments/status", async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (!sessionRepository) {
      return reply.status(503).send({
        error: { code: "PERSISTENCE_NOT_CONFIGURED", message: "O armazenamento não está configurado." },
      });
    }

    try {
      if (!(await sessionRepository.isReady())) {
        return reply.status(503).send({
          error: { code: "PERSISTENCE_UNAVAILABLE", message: "O armazenamento está indisponível." },
        });
      }
      const order = await sessionRepository.findOrderBySessionId(request.params.sessionId);
      if (!order) {
        return reply.status(404).send({
          error: { code: "PAYMENT_NOT_FOUND", message: "Não há cobrança para esta análise." },
        });
      }
      return reply.send({ status: order.status });
    } catch {
      request.log.warn({ event: "payment_status_lookup_failed" }, "Payment status lookup failed");
      return reply.status(503).send({
        error: { code: "PERSISTENCE_UNAVAILABLE", message: "O armazenamento está indisponível." },
      });
    }
  });

  app.post<{ Params: { sessionId: string } }>("/sessions/:sessionId/documents", async (request, reply) => {
    const validation = validateDocumentRequest(request.body);
    if (!validation.success) {
      return reply.status(400).send({
        error: {
          code: "INVALID_DOCUMENT_REQUEST",
          message: "Envie somente os identificadores das sugestões aprovadas.",
        },
      });
    }
    if (!documentService) {
      return reply.status(503).send({
        error: {
          code: "DOCUMENT_NOT_CONFIGURED",
          message: "A geração segura do documento não está configurada neste ambiente.",
        },
      });
    }

    try {
      const document = await documentService.generateDocument(
        request.params.sessionId,
        validation.data.approvedSuggestionIds,
      );
      return reply
        .header("cache-control", "no-store")
        .header("referrer-policy", "no-referrer")
        .status(document.created ? 201 : 200)
        .send({
        format: document.format,
        downloadPath: document.downloadPath,
        expiresAt: document.expiresAt,
      });
    } catch (error) {
      if (error instanceof DocumentServiceError) {
        const mapping: Record<
          DocumentServiceError["code"],
          { statusCode: number; message: string }
        > = {
          PERSISTENCE_UNAVAILABLE: { statusCode: 503, message: "O armazenamento está indisponível." },
          SESSION_NOT_AVAILABLE: { statusCode: 404, message: "A análise expirou ou não está disponível." },
          PAYMENT_NOT_APPROVED: { statusCode: 409, message: "A cobrança ainda não foi aprovada." },
          INVALID_APPROVED_SUGGESTIONS: { statusCode: 400, message: "As sugestões aprovadas não são válidas." },
          DOCUMENT_RENDER_FAILED: { statusCode: 500, message: "Não foi possível montar o PDF." },
          DOCUMENT_STORAGE_UNAVAILABLE: { statusCode: 503, message: "O documento não pôde ser armazenado." },
          DOCUMENT_NOT_AVAILABLE: { statusCode: 404, message: "O documento não está disponível." },
        };
        const mapped = mapping[error.code];
        request.log.warn({ event: "document_generation_failed", reason: error.code }, "Document generation failed");
        return reply.status(mapped.statusCode).send({
          error: { code: error.code, message: mapped.message },
        });
      }

      request.log.error({ event: "document_generation_failed", reason: "unexpected_error" }, "Document generation failed");
      return reply.status(500).send({
        error: { code: "DOCUMENT_GENERATION_FAILED", message: "Não foi possível gerar o documento." },
      });
    }
  });

  app.get<{ Params: { sessionId: string }; Querystring: { token?: string } }>("/documents/:sessionId", async (request, reply) => {
    reply.header("cache-control", "private, no-store, max-age=0").header("referrer-policy", "no-referrer");
    if (!documentService || typeof request.query.token !== "string") {
      return reply.status(404).send({
        error: { code: "DOCUMENT_NOT_AVAILABLE", message: "O documento não está disponível." },
      });
    }

    try {
      const document = await documentService.downloadDocument(request.params.sessionId, request.query.token);
      return reply
        .header("content-type", "application/pdf")
        .header("content-disposition", 'attachment; filename="curriculo.pdf"')
        .header("cache-control", "private, no-store, max-age=0")
        .header("referrer-policy", "no-referrer")
        .header("x-content-type-options", "nosniff")
        .send(document);
    } catch (error) {
      if (error instanceof DocumentServiceError) {
        if (error.code === "PERSISTENCE_UNAVAILABLE" || error.code === "DOCUMENT_STORAGE_UNAVAILABLE") {
          return reply.status(503).send({
            error: { code: error.code, message: "O download não está disponível neste momento." },
          });
        }
        return reply.status(404).send({
          error: { code: "DOCUMENT_NOT_AVAILABLE", message: "O documento não está disponível." },
        });
      }

      request.log.error({ event: "document_download_failed", reason: "unexpected_error" }, "Document download failed");
      return reply.status(500).send({
        error: { code: "DOCUMENT_DOWNLOAD_FAILED", message: "Não foi possível baixar o documento." },
      });
    }
  });

  app.post("/webhooks/mercadopago", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const body = isRecord(request.body) ? request.body : undefined;
    const isPaymentEvent =
      body?.type === "payment" || query.type === "payment" || query.topic === "payment";
    if (!isPaymentEvent) return reply.status(200).send({ received: true });

    if (!paymentWebhook) {
      return reply.status(503).send({
        error: {
          code: "PAYMENT_WEBHOOK_NOT_CONFIGURED",
          message: "A confirmação de pagamentos não está configurada neste ambiente.",
        },
      });
    }

    const paymentId = query["data.id"];
    const signature = request.headers["x-signature"];
    const requestId = request.headers["x-request-id"];
    if (
      typeof paymentId !== "string" ||
      !/^[a-z\d_-]{1,64}$/i.test(paymentId) ||
      typeof signature !== "string" ||
      typeof requestId !== "string"
    ) {
      return reply.status(400).send({
        error: {
          code: "INVALID_WEBHOOK_REQUEST",
          message: "A notificação de pagamento está incompleta.",
        },
      });
    }

    const bodyData = body && isRecord(body.data) ? body.data.id : undefined;
    if (
      (typeof bodyData === "string" || typeof bodyData === "number") &&
      String(bodyData) !== paymentId
    ) {
      return reply.status(400).send({
        error: {
          code: "INVALID_WEBHOOK_REQUEST",
          message: "A notificação de pagamento está inconsistente.",
        },
      });
    }

    if (!verifyMercadoPagoWebhookSignature(paymentWebhook.secret, signature, requestId, paymentId)) {
      return reply.status(401).send({
        error: {
          code: "INVALID_WEBHOOK_SIGNATURE",
          message: "A assinatura da notificação é inválida.",
        },
      });
    }

    try {
      await paymentWebhook.service.handlePaymentNotification(paymentId);
      return reply.status(200).send({ received: true });
    } catch (error) {
      if (error instanceof PaymentWebhookError) {
        const persistenceUnavailable = error.code === "PERSISTENCE_UNAVAILABLE";
        request.log.warn(
          { event: "payment_webhook_failed", reason: error.code },
          "Payment webhook processing failed",
        );
        return reply.status(persistenceUnavailable ? 503 : 502).send({
          error: {
            code: error.code,
            message: persistenceUnavailable
              ? "O armazenamento não está disponível para confirmar o pagamento."
              : "Não foi possível consultar o pagamento no provedor.",
          },
        });
      }

      request.log.error(
        { event: "payment_webhook_failed", reason: "unexpected_error" },
        "Payment webhook processing failed",
      );
      return reply.status(500).send({
        error: {
          code: "PAYMENT_WEBHOOK_FAILED",
          message: "Não foi possível processar a confirmação do pagamento.",
        },
      });
    }
  });

  return app;
}
