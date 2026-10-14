import {
  AnalysisProviderError,
  type AnalysisProviderFailureReason,
} from "./analysis-errors.js";
import type {
  AnalysisProvider,
  GenerateAnalysisRequest,
  GeneratedAnalysis,
} from "./openai-responses-provider.js";

type GeminiAnalysisProviderOptions = {
  apiKey: string;
  model: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-z0-9_-]{1,64}$/i.test(value)
    ? value.toUpperCase()
    : undefined;
}

function safeRequestId(value: string | null): string | undefined {
  const requestId = value?.trim();
  return requestId && /^[a-z0-9_-]{1,100}$/i.test(requestId) ? requestId : undefined;
}

function usageCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function classifyHttpFailure(status: number, providerCode?: string): AnalysisProviderFailureReason {
  if (status === 401) return "authentication_failed";
  if (status === 403) return "permission_denied";
  if (status === 429) {
    return providerCode === "RESOURCE_EXHAUSTED" ? "quota_exhausted" : "rate_limited";
  }
  if (status === 404) return "model_unavailable";
  if (status >= 500) return "provider_server_error";
  return "request_rejected";
}

async function providerHttpError(response: Response): Promise<AnalysisProviderError> {
  let providerCode: string | undefined;
  try {
    const body: unknown = await response.json();
    if (isRecord(body) && isRecord(body.error)) {
      providerCode = safeCode(body.error.status) ?? safeCode(body.error.code);
    }
  } catch {
    // Use only status metadata if the provider error body is absent or malformed.
  }

  const requestId = safeRequestId(
    response.headers.get("x-goog-request-id") ?? response.headers.get("x-request-id"),
  );
  return new AnalysisProviderError({
    provider: "gemini",
    reason: classifyHttpFailure(response.status, providerCode),
    httpStatus: response.status,
    ...(requestId ? { requestId } : {}),
  });
}

function isTimeout(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error &&
    (error.name === "TimeoutError" || error.name === "AbortError");
}

function invalidResponse(response?: Response): AnalysisProviderError {
  const requestId = safeRequestId(
    response?.headers.get("x-goog-request-id") ?? response?.headers.get("x-request-id") ?? null,
  );
  return new AnalysisProviderError({
    provider: "gemini",
    reason: "invalid_provider_response",
    ...(response ? { httpStatus: response.status } : {}),
    ...(requestId ? { requestId } : {}),
  });
}

/** Gemini accepts a JSON Schema subset; OpenAI-specific strict/additionalProperties metadata is omitted. */
export function toGeminiResponseSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toGeminiResponseSchema);
  if (!isRecord(value)) return value;

  const supported: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (key === "additionalProperties" || key === "$schema" || key === "strict") continue;
    supported[key] = toGeminiResponseSchema(nestedValue);
  }
  return supported;
}

function extractGeneratedContent(body: unknown): {
  outputText: string;
  inputTokens: number;
  outputTokens: number;
} | undefined {
  if (!isRecord(body) || !Array.isArray(body.candidates) || body.candidates.length !== 1) {
    return undefined;
  }

  const candidate = body.candidates[0];
  if (
    !isRecord(candidate) ||
    (candidate.finishReason !== undefined && candidate.finishReason !== "STOP") ||
    !isRecord(candidate.content) ||
    !Array.isArray(candidate.content.parts)
  ) {
    return undefined;
  }

  const textParts = candidate.content.parts
    .filter((part): part is Record<string, unknown> =>
      isRecord(part) && typeof part.text === "string" && part.thought !== true,
    )
    .map((part) => part.text as string);
  if (textParts.length !== 1) return undefined;

  if (!isRecord(body.usageMetadata)) return undefined;
  const inputTokens = usageCount(body.usageMetadata.promptTokenCount);
  const totalTokens = usageCount(body.usageMetadata.totalTokenCount);
  if (inputTokens === undefined || totalTokens === undefined || totalTokens < inputTokens) {
    return undefined;
  }

  const outputTokens = totalTokens - inputTokens;
  const candidateTokens = usageCount(body.usageMetadata.candidatesTokenCount);
  const thoughtTokens = body.usageMetadata.thoughtsTokenCount === undefined
    ? 0
    : usageCount(body.usageMetadata.thoughtsTokenCount);
  if (
    (body.usageMetadata.candidatesTokenCount !== undefined && candidateTokens === undefined) ||
    thoughtTokens === undefined ||
    (candidateTokens !== undefined && candidateTokens + thoughtTokens > outputTokens)
  ) {
    return undefined;
  }

  return { outputText: textParts[0]!, inputTokens, outputTokens };
}

/** Gemini Developer API provider; credentials are sent only in a backend request header. */
export class GeminiAnalysisProvider implements AnalysisProvider {
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: GeminiAnalysisProviderOptions) {
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  async generate(request: GenerateAnalysisRequest): Promise<GeneratedAnalysis> {
    let response: Response;
    try {
      response = await this.fetcher(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.options.model)}:generateContent`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": this.options.apiKey,
          },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: request.instructions }] },
            contents: [{ role: "user", parts: [{ text: request.input }] }],
            generationConfig: {
              responseMimeType: "application/json",
              responseSchema: toGeminiResponseSchema(request.responseSchema),
              maxOutputTokens: request.maxOutputTokens,
            },
          }),
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
    } catch (error) {
      throw new AnalysisProviderError({
        provider: "gemini",
        reason: isTimeout(error) ? "timeout" : "network_error",
      });
    }

    if (!response.ok) throw await providerHttpError(response);

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw invalidResponse(response);
    }

    const generated = extractGeneratedContent(body);
    if (!generated) throw invalidResponse(response);
    return generated;
  }
}
