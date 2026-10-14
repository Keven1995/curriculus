import { ANALYSIS_OUTPUT_SCHEMA, parseAnalysisOutput, type AnalysisOutput } from "./analysis-output.js";
import {
  AnalysisInputTokenLimitError,
  AnalysisUsageLimitError,
  InvalidAnalysisOutputError,
  JobDescriptionRequiredError,
} from "./analysis-errors.js";
import { ANALYSIS_INSTRUCTIONS, serializeAnalysisInput } from "./analysis-prompt.js";
import type { AnalysisRequest } from "./analysis-request.js";
import type { AnalysisProvider } from "./openai-responses-provider.js";

export type TokenCounter = {
  count(input: string): number;
};

export type AnalysisPricing = {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
};

export type AnalysisUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number | null;
};

export type AnalysisRun = {
  analysis: AnalysisOutput;
  usage: AnalysisUsage;
};

type AnalysisServiceOptions = {
  provider: AnalysisProvider;
  tokenCounter: TokenCounter;
  maxInputTokens: number;
  maxOutputTokens: number;
  inputSafetyMarginTokens?: number;
  pricing?: AnalysisPricing;
};

export type AnalysisService = {
  analyze(request: AnalysisRequest): Promise<AnalysisRun>;
};

function estimateCost(usage: { inputTokens: number; outputTokens: number }, pricing?: AnalysisPricing): number | null {
  if (!pricing) return null;

  const cost =
    (usage.inputTokens * pricing.inputUsdPerMillion +
      usage.outputTokens * pricing.outputUsdPerMillion) /
    1_000_000;
  return Number(cost.toFixed(12));
}

export function createAnalysisService(options: AnalysisServiceOptions): AnalysisService {
  const inputSafetyMarginTokens = options.inputSafetyMarginTokens ?? 256;

  return {
    async analyze(request) {
      if (!request.jobDescription?.trim()) {
        throw new JobDescriptionRequiredError();
      }

      const input = serializeAnalysisInput(request);
      const schema = JSON.stringify(ANALYSIS_OUTPUT_SCHEMA);
      const estimatedInputTokens =
        options.tokenCounter.count(`${ANALYSIS_INSTRUCTIONS}\n${input}\n${schema}`) +
        inputSafetyMarginTokens;

      if (estimatedInputTokens > options.maxInputTokens) {
        throw new AnalysisInputTokenLimitError(
          estimatedInputTokens,
          options.maxInputTokens,
        );
      }

      // Deliberately one model call: malformed or unsupported output is not regenerated.
      const generated = await options.provider.generate({
        instructions: ANALYSIS_INSTRUCTIONS,
        input,
        responseSchema: ANALYSIS_OUTPUT_SCHEMA,
        maxOutputTokens: options.maxOutputTokens,
      });

      if (
        generated.inputTokens > options.maxInputTokens ||
        generated.outputTokens > options.maxOutputTokens
      ) {
        throw new AnalysisUsageLimitError();
      }

      let parsedOutput: unknown;
      try {
        parsedOutput = JSON.parse(generated.outputText);
      } catch {
        throw new InvalidAnalysisOutputError("invalid_json");
      }

      const validation = parseAnalysisOutput(parsedOutput, request.resume);
      if (!validation.success) {
        throw new InvalidAnalysisOutputError(validation.issues[0] ?? "invalid_root");
      }

      const usage = {
        inputTokens: generated.inputTokens,
        outputTokens: generated.outputTokens,
      };

      return {
        analysis: validation.data,
        usage: {
          ...usage,
          totalTokens: usage.inputTokens + usage.outputTokens,
          estimatedCostUsd: estimateCost(usage, options.pricing),
        },
      };
    },
  };
}
