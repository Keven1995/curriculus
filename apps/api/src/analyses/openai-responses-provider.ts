import {
  AnalysisProviderError,
  type AnalysisProviderFailureReason,
} from "./analysis-errors.js";

export type GenerateAnalysisRequest = {
  instructions: string;
  input: string;
  responseSchema: Record<string, unknown>;
  maxOutputTokens: number;
};

export type GeneratedAnalysis = {
  outputText: string;
  inputTokens: number;
  outputTokens: number;
};

export interface AnalysisProvider {
  generate(request: GenerateAnalysisRequest): Promise<GeneratedAnalysis>;
}

type OpenAIResponsesProviderOptions = {
  apiKey: string;
  model: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function usageCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

const quotaErrorCodes = new Set([
  "insufficient_quota",
  "billing_hard_limit_reached",
  "billing_not_active",
]);
const rateLimitErrorCodes = new Set(["rate_limit_exceeded"]);
const modelErrorCodes = new Set([
  "model_not_found",
  "model_not_available",
  "unsupported_model",
]);

function safeErrorCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-z0-9_-]{1,64}$/i.test(value)
    ? value.toLowerCase()
    : undefined;
}

function safeRequestId(value: string | null): string | undefined {
  const requestId = value?.trim();
  return requestId && /^[a-z0-9_-]{1,100}$/i.test(requestId) ? requestId : undefined;
}

function classifyHttpFailure(
  status: number,
  code?: string,
  type?: string,
): AnalysisProviderFailureReason {
  if (code === "invalid_api_key" || status === 401) return "authentication_failed";
  if (quotaErrorCodes.has(code ?? "") || type === "insufficient_quota") return "quota_exhausted";
  if (code === "permission_denied" || type === "permission_error" || status === 403) {
    return "permission_denied";
  }
  if (rateLimitErrorCodes.has(code ?? "") || type === "rate_limit_error" || status === 429) {
    return "rate_limited";
  }
  if (modelErrorCodes.has(code ?? "") || status === 404) return "model_unavailable";
  if (status >= 500) return "provider_server_error";
  return "request_rejected";
}

async function providerHttpError(response: Response): Promise<AnalysisProviderError> {
  let code: string | undefined;
  let type: string | undefined;
  try {
    const body: unknown = await response.json();
    if (isRecord(body) && isRecord(body.error)) {
      code = safeErrorCode(body.error.code);
      type = safeErrorCode(body.error.type);
    }
  } catch {
    // The diagnostic intentionally falls back to the HTTP status only.
  }

  const requestId = safeRequestId(response.headers.get("x-request-id"));
  return new AnalysisProviderError({
    reason: classifyHttpFailure(response.status, code, type),
    httpStatus: response.status,
    ...(requestId ? { requestId } : {}),
  });
}

function isTimeout(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error &&
    (error.name === "TimeoutError" || error.name === "AbortError");
}

function invalidProviderResponse(response: Response): AnalysisProviderError {
  const requestId = safeRequestId(response.headers.get("x-request-id"));
  return new AnalysisProviderError({
    reason: "invalid_provider_response",
    httpStatus: response.status,
    ...(requestId ? { requestId } : {}),
  });
}

function extractOutputText(response: unknown): string | undefined {
  if (!isRecord(response) || response.status !== "completed" || !Array.isArray(response.output)) {
    return undefined;
  }

  const outputTexts: string[] = [];
  for (const item of response.output) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (
        isRecord(content) &&
        content.type === "output_text" &&
        typeof content.text === "string"
      ) {
        outputTexts.push(content.text);
      }
    }
  }

  return outputTexts.length === 1 ? outputTexts[0] : undefined;
}

export class OpenAIResponsesProvider implements AnalysisProvider {
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: OpenAIResponsesProviderOptions) {
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  async generate(request: GenerateAnalysisRequest): Promise<GeneratedAnalysis> {
    let response: Response;
    try {
      response = await this.fetcher("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.options.model,
          store: false,
          instructions: request.instructions,
          input: request.input,
          max_output_tokens: request.maxOutputTokens,
          text: {
            format: {
              type: "json_schema",
              name: "curriculus_analysis",
              strict: true,
              schema: request.responseSchema,
            },
          },
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new AnalysisProviderError({ reason: isTimeout(error) ? "timeout" : "network_error" });
    }

    if (!response.ok) {
      throw await providerHttpError(response);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw invalidProviderResponse(response);
    }

    const outputText = extractOutputText(body);
    if (!outputText || !isRecord(body) || !isRecord(body.usage)) {
      throw invalidProviderResponse(response);
    }

    const inputTokens = usageCount(body.usage.input_tokens);
    const outputTokens = usageCount(body.usage.output_tokens);
    if (inputTokens === undefined || outputTokens === undefined) {
      throw invalidProviderResponse(response);
    }

    return { outputText, inputTokens, outputTokens };
  }
}
