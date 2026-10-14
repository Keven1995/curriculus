import cors from "@fastify/cors";
import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyLoggerOptions,
} from "fastify";
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
import { DOCUMENT_REQUEST_LIMITS, validateDocumentRequest } from "./documents/document-request.js";
import { DocumentServiceError, type DocumentService } from "./documents/document-service.js";
import { createConfiguredDataDeletionService } from "./privacy/configured-data-deletion-service.js";
import { DataDeletionServiceError, type DataDeletionService } from "./privacy/data-deletion-service.js";
import { HttpMetrics } from "./security/http-metrics.js";
import { InMemoryRateLimiter, type RateLimitPolicy } from "./security/in-memory-rate-limiter.js";
import {
  isStrongSecret,
  matchesBearerSecret,
  parseTrustedProxyHops,
  resolveCorsOrigin,
} from "./security/server-configuration.js";
import { RESUME_LAYOUT_LIMITS } from "./resume-layout/resume-layout-types.js";
import { ResumeLayoutError, type ResumeLayoutErrorCode } from "./resume-layout/resume-layout-errors.js";
import { ResumeLayoutService } from "./resume-layout/resume-layout-service.js";

type RateLimitScope =
  | "global"
  | "analysis"
  | "analysisDaily"
  | "deletion"
  | "payment"
  | "paymentStatus"
  | "documentGeneration"
  | "documentDownload"
  | "layoutImport"
  | "layoutDelete"
  | "webhook";

type RateLimitRequest = { ip: string };
type RateLimitReply = {
  header(name: string, value: string): unknown;
  status(code: number): { send(payload: unknown): unknown };
};

const DEFAULT_RATE_LIMITS: Record<RateLimitScope, RateLimitPolicy> = {
  global: { limit: 120, windowMs: 60_000 },
  analysis: { limit: 5, windowMs: 15 * 60_000 },
  analysisDaily: { limit: 20, windowMs: 24 * 60 * 60_000 },
  deletion: { limit: 10, windowMs: 15 * 60_000 },
  payment: { limit: 10, windowMs: 15 * 60_000 },
  paymentStatus: { limit: 60, windowMs: 60_000 },
  documentGeneration: { limit: 10, windowMs: 15 * 60_000 },
  documentDownload: { limit: 30, windowMs: 60_000 },
  layoutImport: { limit: 5, windowMs: 15 * 60_000 },
  layoutDelete: { limit: 10, windowMs: 15 * 60_000 },
  webhook: { limit: 300, windowMs: 60_000 },
};

type AppOptions = {
  webOrigin?: string;
  production?: boolean;
  trustedProxyHops?: number;
  metricsToken?: string | null;
  rateLimitPolicies?: Partial<Record<RateLimitScope, RateLimitPolicy>>;
  logger?: boolean | FastifyLoggerOptions;
  analysisService?: AnalysisService | null;
  sessionRepository?: SessionRepository | null;
  pixPaymentService?: PixPaymentServiceContract | null;
  paymentWebhook?: PaymentWebhookEndpoint | null;
  documentService?: Pick<DocumentService, "generateDocument" | "downloadDocument" | "deleteExpiredDocuments"> | null;
  dataDeletionService?: Pick<DataDeletionService, "deleteSessionData"> | null;
  localTestMode?: boolean;
  resumeLayoutImportEnabled?: boolean;
  resumeLayoutService?: Pick<ResumeLayoutService, "importPdf" | "getTemplate" | "deleteTemplate" | "isBackedBy"> | null;
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

const resumeLayoutFailures: Record<ResumeLayoutErrorCode, { statusCode: number; message: string }> = {
  invalid_pdf: { statusCode: 400, message: "O arquivo PDF está inválido ou corrompido." },
  file_too_large: { statusCode: 413, message: "O PDF deve ter no máximo 10 MiB." },
  too_many_pages: { statusCode: 413, message: "O PDF deve ter no máximo 30 páginas." },
  no_selectable_text: { statusCode: 422, message: "Não encontramos texto selecionável. O PDF parece digitalizado; OCR não está habilitado." },
  text_too_long: { statusCode: 413, message: "O texto do PDF excede o limite de extração." },
  encrypted_pdf: { statusCode: 422, message: "PDFs protegidos por senha não são compatíveis." },
  template_expired: { statusCode: 410, message: "O estilo visual não está mais disponível; você pode continuar sem reenviar o PDF." },
  processing_timeout: { statusCode: 408, message: "A extração excedeu o tempo permitido. Tente um PDF menor ou mais simples." },
  render_failed: { statusCode: 500, message: "Não foi possível gerar o PDF. Revise os dados e tente novamente." },
};

export function createApp(options: AppOptions = {}): FastifyInstance {
  const production = options.production ?? process.env.NODE_ENV === "production";
  if (production && options.localTestMode) {
    throw new Error("Local test mode must never be enabled in production.");
  }
  const corsOrigin = resolveCorsOrigin(
    options.webOrigin ?? process.env.WEB_ORIGIN,
    production,
  );
  if (production && !corsOrigin) {
    throw new Error("WEB_ORIGIN must be configured as one HTTPS origin in production.");
  }
  const configuredProxyHops = process.env.TRUST_PROXY_HOPS;
  const parsedProxyHops = parseTrustedProxyHops(configuredProxyHops);
  if (configuredProxyHops !== undefined && configuredProxyHops.trim() !== String(parsedProxyHops)) {
    throw new Error("TRUST_PROXY_HOPS must be an integer from 0 to 5.");
  }
  const trustedProxyHops = options.trustedProxyHops ?? parsedProxyHops;
  if (!Number.isInteger(trustedProxyHops) || trustedProxyHops < 0 || trustedProxyHops > 5) {
    throw new Error("TRUST_PROXY_HOPS must be an integer from 0 to 5.");
  }
  const metricsToken = options.metricsToken === undefined
    ? process.env.METRICS_TOKEN
    : options.metricsToken ?? undefined;
  const metrics = new HttpMetrics();
  const rateLimiter = new InMemoryRateLimiter();
  const rateLimitPolicies: Record<RateLimitScope, RateLimitPolicy> = {
    ...DEFAULT_RATE_LIMITS,
    ...options.rateLimitPolicies,
  };

  const rateLimitHook = (scope: RateLimitScope): (
    request: RateLimitRequest,
    reply: RateLimitReply,
  ) => Promise<void> => async (request, reply) => {
    const policy = rateLimitPolicies[scope];
    const decision = rateLimiter.consume(scope, request.ip, policy);
    reply.header("x-ratelimit-limit", String(policy.limit));
    reply.header("x-ratelimit-remaining", String(decision.remaining));
    reply.header("x-ratelimit-reset", String(Math.ceil(Date.now() / 1_000) + decision.retryAfterSeconds));
    if (decision.allowed) return;

    reply.header("retry-after", String(decision.retryAfterSeconds));
    await reply.status(429).send({
      error: {
        code: "RATE_LIMITED",
        message: "Muitas solicitações. Aguarde antes de tentar novamente.",
        retryAfterSeconds: decision.retryAfterSeconds,
      },
    });
  };

  const analysisService =
    options.analysisService === undefined
      ? createConfiguredAnalysisService()
      : options.analysisService ?? undefined;
  const sessionRepository =
    options.sessionRepository === undefined
      ? createConfiguredSessionRepository()
      : options.sessionRepository ?? undefined;
  const resumeLayoutService = options.resumeLayoutService === undefined
    ? sessionRepository
      ? new ResumeLayoutService(sessionRepository)
      : undefined
    : options.resumeLayoutService ?? undefined;
  const resumeLayoutImportEnabled = options.resumeLayoutImportEnabled ?? Boolean(options.localTestMode && resumeLayoutService);
  const hasDurableResumeLayoutStore = Boolean(
    sessionRepository &&
    resumeLayoutService instanceof ResumeLayoutService &&
    resumeLayoutService.isBackedBy(sessionRepository),
  );
  if (production && resumeLayoutImportEnabled && !hasDurableResumeLayoutStore) {
    throw new Error("Resume PDF intake requires a configured layout extraction service and persistent database storage.");
  }
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
  const dataDeletionService =
    options.dataDeletionService === undefined
      ? sessionRepository
        ? createConfiguredDataDeletionService(sessionRepository)
        : undefined
      : options.dataDeletionService ?? undefined;
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: ANALYSIS_REQUEST_LIMITS.bodyBytes,
    trustProxy: trustedProxyHops === 0
      ? false
      : (_address, hop) => hop < trustedProxyHops,
    logController: new LogController({ disableRequestLogging: true }),
  });

  if (resumeLayoutService) {
    app.addContentTypeParser("application/pdf", {
      parseAs: "buffer",
      bodyLimit: RESUME_LAYOUT_LIMITS.maximumPdfBytes,
    }, (_request, body, done) => done(null, body));
  }

  void app.register(cors, {
    origin: corsOrigin
      ? (origin, callback) => callback(null, origin === corsOrigin)
      : false,
    methods: ["GET", "HEAD", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["authorization", "content-type", "x-file-name", "x-request-id", "x-signature"],
    maxAge: 600,
  });

  app.addHook("onRequest", rateLimitHook("global"));
  app.addHook("onResponse", async (request, reply) => {
    metrics.record(request.method, request.routeOptions.url, reply.statusCode);
  });
  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    if (!reply.hasHeader("referrer-policy")) reply.header("referrer-policy", "no-referrer");
    reply.header("content-security-policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
    return payload;
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
    const cleanupExpiredResumeLayouts = async () => {
      try {
        const deletedCount = await sessionRepository.deleteExpiredTemporaryResumeLayouts();
        if (deletedCount > 0) {
          app.log.info({ event: "expired_resume_layouts_deleted", deletedCount }, "Expired temporary resume layouts removed");
        }
      } catch {
        app.log.warn({ event: "resume_layout_expiry_cleanup_failed" }, "Temporary resume layout cleanup failed");
      }
    };

    app.addHook("onReady", async () => {
      await cleanupExpiredSessions();
      await cleanupExpiredDocuments();
      await cleanupExpiredResumeLayouts();
      cleanupTimer = setInterval(() => {
        void cleanupExpiredSessions();
        void cleanupExpiredDocuments();
        void cleanupExpiredResumeLayouts();
      }, 15 * 60 * 1000);
      cleanupTimer.unref();
    });
    app.addHook("onClose", async () => {
      if (cleanupTimer) clearInterval(cleanupTimer);
      await sessionRepository.close?.();
    });
  }

  app.setErrorHandler((error, request, reply) => {
    const statusCode =
      typeof error === "object" && error !== null && "statusCode" in error
        ? error.statusCode
        : undefined;

    if (statusCode === 413) {
      return reply.status(413).send({
        error: {
          code: "PAYLOAD_TOO_LARGE",
          message: request.url === "/resume-layouts/import"
            ? "O PDF excede o limite de 10 MiB."
            : "A requisição excede o limite de 256 KiB.",
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

  app.get("/metrics", async (request, reply) => {
    if (!isStrongSecret(metricsToken) || !matchesBearerSecret(metricsToken, request.headers.authorization)) {
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Rota não encontrada." } });
    }
    return reply
      .header("content-type", "text/plain; version=0.0.4; charset=utf-8")
      .header("cache-control", "no-store")
      .send(metrics.renderPrometheus());
  });

  app.delete<{ Params: { sessionId: string } }>("/sessions/:sessionId/data", {
    onRequest: [rateLimitHook("deletion")],
  }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (!dataDeletionService) {
      return reply.status(503).send({
        error: {
          code: "DATA_DELETION_NOT_CONFIGURED",
          message: "A exclusão segura não está disponível neste ambiente.",
        },
      });
    }

    try {
      await dataDeletionService.deleteSessionData(request.params.sessionId);
      return reply.status(204).send();
    } catch (error) {
      if (error instanceof DataDeletionServiceError) {
        const mapping: Record<
          DataDeletionServiceError["code"],
          { statusCode: number; message: string }
        > = {
          INVALID_SESSION: { statusCode: 400, message: "O identificador desta sessão é inválido." },
          PERSISTENCE_UNAVAILABLE: { statusCode: 503, message: "O armazenamento está indisponível; tente novamente." },
          DOCUMENT_STORAGE_UNAVAILABLE: { statusCode: 503, message: "O arquivo não pôde ser removido; tente novamente." },
          PAYMENT_CANCELLATION_UNAVAILABLE: { statusCode: 503, message: "Não foi possível cancelar a cobrança Pix. Seus dados não foram excluídos; tente novamente." },
          SESSION_DELETION_CONFLICT: { statusCode: 409, message: "A sessão mudou durante a exclusão; tente novamente." },
        };
        const mapped = mapping[error.code];
        request.log.warn({ event: "data_deletion_failed", reason: error.code }, "Session data deletion failed");
        return reply.status(mapped.statusCode).send({
          error: { code: error.code, message: mapped.message },
        });
      }

      request.log.error({ event: "data_deletion_failed", reason: "unexpected_error" }, "Session data deletion failed");
      return reply.status(500).send({
        error: { code: "DATA_DELETION_FAILED", message: "Não foi possível concluir a exclusão." },
      });
    }
  });

  app.post("/analyses", {
    onRequest: [rateLimitHook("analysis"), rateLimitHook("analysisDaily")],
  }, async (request, reply) => {
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

    let hasResumeLayout = false;
    if (validation.data.resumeLayoutTemplateId) {
      if (!resumeLayoutImportEnabled || !resumeLayoutService) {
        return reply.status(409).send({
          error: {
            code: "LAYOUT_IMPORT_NOT_AVAILABLE",
            message: "A extração do PDF não está disponível neste momento.",
          },
        });
      }
      const resumeLayoutTemplate = await resumeLayoutService.getTemplate(validation.data.resumeLayoutTemplateId);
      if (!resumeLayoutTemplate) {
        return reply.status(410).send({
          error: { code: "TEMPLATE_EXPIRED", message: "O estilo visual não está mais disponível; continue sem reenviar o PDF." },
        });
      }
      hasResumeLayout = true;
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
      const { resumeLayoutTemplateId: _resumeLayoutTemplateId, ...analysisInput } = validation.data;
      const result = await analysisService.analyze(analysisInput);
      const sessionInput = {
        jobUrl: validation.data.jobUrl,
        jobDescription: validation.data.jobDescription,
        resume: validation.data.resume,
        analysis: result.analysis,
        usage: result.usage,
      };
      const session = validation.data.resumeLayoutTemplateId
        ? await sessionRepository.createSessionWithTemporaryLayout(
          sessionInput,
          validation.data.resumeLayoutTemplateId,
        )
        : await sessionRepository.createSession(sessionInput);
      if (!session) {
        return reply.status(410).send({
          error: { code: "TEMPLATE_EXPIRED", message: "O estilo visual expirou durante a análise; continue sem reenviar o PDF." },
        });
      }
      request.log.info(
        {
          event: "analysis_completed",
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
        ...(hasResumeLayout ? { usesReferenceLayout: true } : {}),
        ...(options.localTestMode ? { localTestMode: true } : {}),
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
        // Keep diagnostics limited to normalized provider metadata; never log the exception,
        // response body, API key, request payload, résumé, or job description.
        request.log.warn({
          event: "analysis_failed",
          reason: "provider_error",
          provider: error.diagnostics.provider ?? "openai",
          providerFailure: error.diagnostics.reason,
          ...(error.diagnostics.httpStatus !== undefined
            ? { providerStatusCode: error.diagnostics.httpStatus }
            : {}),
          ...(error.diagnostics.requestId
            ? { providerRequestId: error.diagnostics.requestId }
            : {}),
        }, "Analysis provider failed");
        const temporarilyUnavailable =
          error.diagnostics.reason === "rate_limited" ||
          error.diagnostics.reason === "quota_exhausted";
        return reply.status(temporarilyUnavailable ? 503 : 502).send({
          error: {
            code: "ANALYSIS_PROVIDER_ERROR",
            message: temporarilyUnavailable
              ? "Análises temporariamente indisponíveis. Tente novamente mais tarde."
              : "Não foi possível concluir a análise. Tente novamente mais tarde.",
          },
        });
      }

      if (error instanceof InvalidAnalysisOutputError) {
        request.log.warn({
          event: "analysis_failed",
          reason: "invalid_model_output",
          validationFailure: error.validationFailure,
        }, "Analysis output rejected");
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

  app.post<{ Params: { sessionId: string } }>("/sessions/:sessionId/payments/pix", {
    onRequest: [rateLimitHook("payment")],
  }, async (request, reply) => {
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

  app.get<{ Params: { sessionId: string } }>("/sessions/:sessionId/payments/status", {
    onRequest: [rateLimitHook("paymentStatus")],
  }, async (request, reply) => {
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

  app.post<{ Params: { sessionId: string } }>("/sessions/:sessionId/documents", {
    onRequest: [rateLimitHook("documentGeneration")],
    bodyLimit: DOCUMENT_REQUEST_LIMITS.maximumBodyBytes,
  }, async (request, reply) => {
    const validation = validateDocumentRequest(request.body);
    if (!validation.success) {
      return reply.status(400).send({
        error: {
          code: "INVALID_DOCUMENT_REQUEST",
          message: "Envie os identificadores aprovados e um texto final válido.",
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
        validation.data.finalResumeText,
      );
      return reply
        .header("cache-control", "no-store")
        .header("referrer-policy", "no-referrer")
        .status(document.created ? 201 : 200)
        .send({
        format: document.format,
        downloadPath: document.downloadPath,
        expiresAt: document.expiresAt,
        layoutFallback: document.layoutFallback,
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
          INVALID_FINAL_RESUME: { statusCode: 400, message: "O texto final excede os limites ou contém caracteres inválidos." },
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

  app.get<{ Params: { sessionId: string }; Querystring: { token?: string } }>("/documents/:sessionId", {
    onRequest: [rateLimitHook("documentDownload")],
  }, async (request, reply) => {
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

  app.post("/webhooks/mercadopago", { onRequest: [rateLimitHook("webhook")] }, async (request, reply) => {
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

  app.get("/features", async (_request, reply) =>
    reply.header("cache-control", "no-store").send({ resumeLayoutImport: Boolean(resumeLayoutImportEnabled && resumeLayoutService) }),
  );

  app.post<{ Body: Buffer }>("/resume-layouts/import", {
    onRequest: [rateLimitHook("layoutImport")],
  }, async (request, reply) => {
    reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer");
    if (!resumeLayoutImportEnabled || !resumeLayoutService) {
      return reply.status(404).send({ error: { code: "FEATURE_NOT_AVAILABLE", message: "A importação de layout não está habilitada neste ambiente." } });
    }
    if (sessionRepository && !(await sessionRepository.isReady())) {
      return reply.status(503).send({
        error: { code: "PERSISTENCE_UNAVAILABLE", message: "O armazenamento temporário não está disponível neste momento." },
      });
    }
    if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/pdf") {
      return reply.status(415).send({ error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "Envie o arquivo como application/pdf." } });
    }
    if (!Buffer.isBuffer(request.body)) {
      return reply.status(400).send({ error: { code: "INVALID_PDF", message: "Não foi possível ler o arquivo PDF." } });
    }
    const encodedName = request.headers["x-file-name"];
    let fileName = "referencia.pdf";
    if (typeof encodedName === "string" && encodedName.length <= 720) {
      try {
        fileName = decodeURIComponent(encodedName);
      } catch {
        fileName = "referencia.pdf";
      }
    }

    try {
      const imported = await resumeLayoutService.importPdf(request.body, fileName);
      const result = {
        resumeText: imported.resumeText,
        layoutAvailable: imported.layoutAvailable,
        expiresAt: imported.expiresAt,
        ...(imported.layoutAvailable ? { templateId: imported.templateId } : {}),
      };
      return reply.status(201).send(result);
    } catch (error) {
      if (error instanceof ResumeLayoutError) {
        request.log.warn({ event: "resume_layout_import_failed", reason: error.code }, "Resume layout import failed");
        return reply.status(resumeLayoutFailures[error.code].statusCode).send({
          error: { code: error.code.toUpperCase(), message: resumeLayoutFailures[error.code].message },
        });
      }
      request.log.warn({ event: "resume_layout_import_failed", reason: "unexpected_error" }, "Resume layout import failed");
      return reply.status(500).send({ error: { code: "RESUME_LAYOUT_IMPORT_FAILED", message: "Não foi possível extrair o layout do PDF." } });
    }
  });

  app.delete<{ Params: { templateId: string } }>("/resume-layouts/:templateId", {
    onRequest: [rateLimitHook("layoutDelete")],
  }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (!resumeLayoutImportEnabled || !resumeLayoutService) return reply.status(404).send();
    if (!/^[0-9a-f-]{36}$/i.test(request.params.templateId)) return reply.status(204).send();
    await resumeLayoutService.deleteTemplate(request.params.templateId);
    return reply.status(204).send();
  });

  return app;
}
