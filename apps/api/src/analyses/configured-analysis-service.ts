import { getEncoding, type TiktokenEncoding } from "js-tiktoken";
import { createAnalysisService, type AnalysisPricing, type TokenCounter } from "./analysis-service.js";
import { GeminiAnalysisProvider } from "./gemini-analysis-provider.js";
import { MockAnalysisProvider } from "./mock-analysis-provider.js";
import { OpenAIResponsesProvider } from "./openai-responses-provider.js";
import { isStrongSecret } from "../security/server-configuration.js";

export const ANALYSIS_TOKEN_BUDGET = {
  input: 30_000,
  output: 4_000,
} as const;

const supportedEncodings = new Set(["cl100k_base", "o200k_base"]);
const defaultEncoding: TiktokenEncoding = "o200k_base";

type ConfiguredProviderName = "mock" | "gemini" | "openai";

function positiveInteger(value: string | undefined, fallback: number, maximum: number): number | undefined {
  if (value === undefined || value.trim() === "") return fallback;
  if (!/^\d+$/.test(value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : undefined;
}

function selectedProvider(environment: NodeJS.ProcessEnv): ConfiguredProviderName | undefined {
  const configured = environment.AI_PROVIDER?.trim().toLowerCase();
  if (configured !== undefined && configured !== "") {
    return configured === "mock" || configured === "gemini" || configured === "openai"
      ? configured
      : undefined;
  }

  // Compatibility alias for existing local/deployment configurations. Never use this as a
  // fallback after an explicitly selected provider fails validation.
  if (environment.OPENAI_ANALYSIS_ENABLED === "true") return "openai";

  // An ordinary development server starts without a paid key. A production service must
  // choose and enable a provider explicitly.
  if (environment.NODE_ENV === "development" && environment.AI_ANALYSIS_ENABLED !== "false") {
    return "mock";
  }
  return undefined;
}

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
  const explicitlyEnabled = environment.AI_ANALYSIS_ENABLED === "true";
  const legacyEnabled = environment.AI_PROVIDER === undefined && environment.OPENAI_ANALYSIS_ENABLED === "true";
  const providerName = selectedProvider(environment);
  if (!providerName) return undefined;

  // AI_ANALYSIS_ENABLED=false always wins. Explicit provider choices require explicit
  // enablement, except for the development-only mock default and the legacy alias.
  if (environment.AI_ANALYSIS_ENABLED === "false") return undefined;
  const developmentMockDefault =
    providerName === "mock" &&
    environment.AI_PROVIDER === undefined &&
    environment.NODE_ENV === "development";
  if (!explicitlyEnabled && !legacyEnabled && !developmentMockDefault) return undefined;

  // Paid and third-party analysis remains unavailable in production until a server-side
  // entitlement reservation/consumption gate exists. Mock data is never allowed in prod.
  if (environment.NODE_ENV === "production") return undefined;

  const inputBudget = positiveInteger(environment.AI_MAX_INPUT_TOKENS, ANALYSIS_TOKEN_BUDGET.input, 100_000);
  const outputBudget = positiveInteger(environment.AI_MAX_OUTPUT_TOKENS, ANALYSIS_TOKEN_BUDGET.output, 16_000);
  const timeoutMs = positiveInteger(environment.AI_PROVIDER_TIMEOUT_MS, 60_000, 120_000);
  const configuredMargin = environment.AI_INPUT_SAFETY_MARGIN_TOKENS;
  const safetyMargin = configuredMargin === undefined || configuredMargin.trim() === ""
    ? providerName === "gemini" ? 1_024 : providerName === "mock" ? 0 : 256
    : /^\d+$/.test(configuredMargin.trim()) && Number.isSafeInteger(Number(configuredMargin))
      ? Number(configuredMargin)
      : undefined;
  if (
    inputBudget === undefined || outputBudget === undefined || timeoutMs === undefined ||
    safetyMargin === undefined || safetyMargin < 0 || safetyMargin > inputBudget
  ) {
    return undefined;
  }

  const encoding = (
    environment.AI_TOKENIZER_ENCODING ?? environment.OPENAI_TOKENIZER_ENCODING ?? defaultEncoding
  ).trim();
  if (!supportedEncodings.has(encoding)) return undefined;
  const tokenizer = providerName === "gemini" ? undefined : getEncoding(encoding as TiktokenEncoding);

  let provider;
  if (providerName === "mock") {
    provider = new MockAnalysisProvider();
  } else if (providerName === "gemini") {
    const apiKey = environment.GEMINI_API_KEY?.trim();
    const model = environment.GEMINI_MODEL?.trim();
    if (!isStrongSecret(apiKey) || !model || !/^[a-z0-9._-]{1,128}$/i.test(model)) return undefined;
    provider = new GeminiAnalysisProvider({ apiKey, model, timeoutMs });
  } else {
    const apiKey = environment.OPENAI_API_KEY?.trim();
    const model = environment.OPENAI_MODEL?.trim();
    const openAiEncoding = environment.OPENAI_TOKENIZER_ENCODING?.trim();
    if (!isStrongSecret(apiKey) || !model || !openAiEncoding || !supportedEncodings.has(openAiEncoding)) {
      return undefined;
    }
    provider = new OpenAIResponsesProvider({ apiKey, model, timeoutMs });
  }

  const tokenCounter: TokenCounter = providerName === "gemini"
    ? {
        // A UTF-8 byte count is intentionally conservative for a pre-call guard; Gemini's
        // authoritative prompt/total token counts are checked after generation.
        count(input) {
          return Buffer.byteLength(input, "utf8");
        },
      }
    : {
        count(input) {
          return tokenizer!.encode(input).length;
        },
      };
  return createAnalysisService({
    provider,
    tokenCounter,
    maxInputTokens: inputBudget,
    maxOutputTokens: outputBudget,
    inputSafetyMarginTokens: safetyMargin,
    pricing: providerName === "openai" ? configuredPricing(environment) : undefined,
  });
}
