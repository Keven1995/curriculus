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

type AppOptions = {
  webOrigin?: string;
  logger?: boolean;
  analysisService?: AnalysisService | null;
  sessionRepository?: SessionRepository | null;
  pixPaymentService?: PixPaymentServiceContract | null;
};

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

    app.addHook("onReady", async () => {
      await cleanupExpiredSessions();
      cleanupTimer = setInterval(() => void cleanupExpiredSessions(), 15 * 60 * 1000);
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

  return app;
}
