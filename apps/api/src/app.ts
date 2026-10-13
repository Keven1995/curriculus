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

type AppOptions = {
  webOrigin?: string;
  logger?: boolean;
  analysisService?: AnalysisService | null;
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
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: ANALYSIS_REQUEST_LIMITS.bodyBytes,
    logController: new LogController({ disableRequestLogging: true }),
  });

  void app.register(cors, {
    origin: options.webOrigin ?? process.env.WEB_ORIGIN ?? "http://localhost:3000",
  });

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

    try {
      const result = await analysisService.analyze(validation.data);
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
      return reply.status(200).send(result);
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

  return app;
}
