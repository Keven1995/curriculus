import { AnalysisProviderError } from "./analysis-errors.js";

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
    } catch {
      throw new AnalysisProviderError();
    }

    if (!response.ok) {
      throw new AnalysisProviderError();
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new AnalysisProviderError();
    }

    const outputText = extractOutputText(body);
    if (!outputText || !isRecord(body) || !isRecord(body.usage)) {
      throw new AnalysisProviderError();
    }

    const inputTokens = usageCount(body.usage.input_tokens);
    const outputTokens = usageCount(body.usage.output_tokens);
    if (inputTokens === undefined || outputTokens === undefined) {
      throw new AnalysisProviderError();
    }

    return { outputText, inputTokens, outputTokens };
  }
}
