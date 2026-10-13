import { getEncoding, type TiktokenEncoding } from "js-tiktoken";
import { createAnalysisService, type AnalysisPricing, type TokenCounter } from "./analysis-service.js";
import { OpenAIResponsesProvider } from "./openai-responses-provider.js";

export const ANALYSIS_TOKEN_BUDGET = {
  input: 30_000,
  output: 4_000,
} as const;

const supportedEncodings = new Set(["cl100k_base", "o200k_base"]);

function configuredPricing(environment: NodeJS.ProcessEnv): AnalysisPricing | undefined {
  const inputRate = Number(environment.OPENAI_INPUT_PRICE_USD_PER_MILLION);
  const outputRate = Number(environment.OPENAI_OUTPUT_PRICE_USD_PER_MILLION);

  if (
    environment.OPENAI_INPUT_PRICE_USD_PER_MILLION?.trim() &&
    environment.OPENAI_OUTPUT_PRICE_USD_PER_MILLION?.trim() &&
    Number.isFinite(inputRate) &&
    Number.isFinite(outputRate) &&
    inputRate >= 0 &&
    outputRate >= 0
  ) {
    return { inputUsdPerMillion: inputRate, outputUsdPerMillion: outputRate };
  }

  return undefined;
}

export function createConfiguredAnalysisService(
  environment: NodeJS.ProcessEnv = process.env,
) {
  if (environment.OPENAI_ANALYSIS_ENABLED !== "true") {
    return undefined;
  }

  const apiKey = environment.OPENAI_API_KEY?.trim();
  const model = environment.OPENAI_MODEL?.trim();
  const encoding = environment.OPENAI_TOKENIZER_ENCODING?.trim();

  if (!apiKey || !model || !encoding || !supportedEncodings.has(encoding)) {
    return undefined;
  }

  const tokenizer = getEncoding(encoding as TiktokenEncoding);
  const tokenCounter: TokenCounter = {
    count(input) {
      return tokenizer.encode(input).length;
    },
  };
  const provider = new OpenAIResponsesProvider({ apiKey, model });

  return createAnalysisService({
    provider,
    tokenCounter,
    maxInputTokens: ANALYSIS_TOKEN_BUDGET.input,
    maxOutputTokens: ANALYSIS_TOKEN_BUDGET.output,
    pricing: configuredPricing(environment),
  });
}
