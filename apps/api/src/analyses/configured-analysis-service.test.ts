import assert from "node:assert/strict";
import test from "node:test";
import { createConfiguredAnalysisService } from "./configured-analysis-service.js";
import { MOCK_ANALYSIS_FIXTURE } from "./mock-analysis-provider.js";

const validApiKey = "test-openai-key-with-at-least-32-random-characters";

test("does not configure the provider without an API key, model, and tokenizer", () => {
  assert.equal(createConfiguredAnalysisService({} as NodeJS.ProcessEnv), undefined);
  assert.equal(
    createConfiguredAnalysisService({
      OPENAI_ANALYSIS_ENABLED: "true",
      OPENAI_API_KEY: validApiKey,
      OPENAI_MODEL: "test-model",
    } as NodeJS.ProcessEnv),
    undefined,
  );
});

test("does not configure the analysis provider with a weak API credential", () => {
  assert.equal(createConfiguredAnalysisService({
    OPENAI_ANALYSIS_ENABLED: "true",
    OPENAI_API_KEY: "short-test-key",
    OPENAI_MODEL: "gpt-test",
    OPENAI_TOKENIZER_ENCODING: "cl100k_base",
  } as NodeJS.ProcessEnv), undefined);
});

test("creates an analysis service for an explicitly configured supported tokenizer", () => {
  const service = createConfiguredAnalysisService({
    OPENAI_ANALYSIS_ENABLED: "true",
    OPENAI_API_KEY: validApiKey,
    OPENAI_MODEL: "test-model",
    OPENAI_TOKENIZER_ENCODING: "o200k_base",
  } as NodeJS.ProcessEnv);

  assert.equal(typeof service?.analyze, "function");
});

test("preserves OpenAI as an explicitly selected provider and lets the new disable flag win", () => {
  const selected = createConfiguredAnalysisService({
    NODE_ENV: "development",
    AI_ANALYSIS_ENABLED: "true",
    AI_PROVIDER: "openai",
    OPENAI_API_KEY: validApiKey,
    OPENAI_MODEL: "test-model",
    OPENAI_TOKENIZER_ENCODING: "o200k_base",
  } as NodeJS.ProcessEnv);
  const disabled = createConfiguredAnalysisService({
    NODE_ENV: "development",
    AI_ANALYSIS_ENABLED: "false",
    AI_PROVIDER: "openai",
    OPENAI_ANALYSIS_ENABLED: "true",
    OPENAI_API_KEY: validApiKey,
    OPENAI_MODEL: "test-model",
    OPENAI_TOKENIZER_ENCODING: "o200k_base",
  } as NodeJS.ProcessEnv);

  assert.equal(typeof selected?.analyze, "function");
  assert.equal(disabled, undefined);
});

test("fails closed for an unknown tokenizer encoding", () => {
  const service = createConfiguredAnalysisService({
    OPENAI_ANALYSIS_ENABLED: "true",
    OPENAI_API_KEY: validApiKey,
    OPENAI_MODEL: "test-model",
    OPENAI_TOKENIZER_ENCODING: "unknown-encoding",
  } as NodeJS.ProcessEnv);

  assert.equal(service, undefined);
});

test("keeps the provider disabled unless explicitly enabled", () => {
  const service = createConfiguredAnalysisService({
    OPENAI_API_KEY: validApiKey,
    OPENAI_MODEL: "test-model",
    OPENAI_TOKENIZER_ENCODING: "o200k_base",
  } as NodeJS.ProcessEnv);

  assert.equal(service, undefined);
});

test("defaults to a deterministic mock in development without a paid API key", async () => {
  const service = createConfiguredAnalysisService({ NODE_ENV: "development" } as NodeJS.ProcessEnv);
  assert.equal(typeof service?.analyze, "function");

  const result = await service!.analyze({
    ...MOCK_ANALYSIS_FIXTURE,
    dataNoticeAcknowledged: true,
  });
  assert.deepEqual(
    result.analysis.jobRequirements.map(({ status }) => status),
    ["demonstrated", "partially_demonstrated", "not_demonstrated"],
  );
  assert.equal(result.usage.estimatedCostUsd, null);
});

test("selects Gemini only when explicitly enabled and fully configured", () => {
  assert.equal(createConfiguredAnalysisService({
    NODE_ENV: "development",
    AI_ANALYSIS_ENABLED: "true",
    AI_PROVIDER: "gemini",
    GEMINI_MODEL: "gemini-2.5-flash-lite",
  } as NodeJS.ProcessEnv), undefined);

  const service = createConfiguredAnalysisService({
    NODE_ENV: "development",
    AI_ANALYSIS_ENABLED: "true",
    AI_PROVIDER: "gemini",
    GEMINI_API_KEY: "test-gemini-key-with-at-least-32-characters",
    GEMINI_MODEL: "gemini-2.5-flash-lite",
  } as NodeJS.ProcessEnv);
  assert.equal(typeof service?.analyze, "function");
});

test("does not fall back when an explicitly selected provider is invalid or incomplete", () => {
  const unknown = createConfiguredAnalysisService({
    NODE_ENV: "development",
    AI_ANALYSIS_ENABLED: "true",
    AI_PROVIDER: "unknown-provider",
    OPENAI_ANALYSIS_ENABLED: "true",
    OPENAI_API_KEY: validApiKey,
    OPENAI_MODEL: "test-model",
    OPENAI_TOKENIZER_ENCODING: "o200k_base",
  } as NodeJS.ProcessEnv);
  const missingGeminiCredentials = createConfiguredAnalysisService({
    NODE_ENV: "development",
    AI_ANALYSIS_ENABLED: "true",
    AI_PROVIDER: "gemini",
    OPENAI_ANALYSIS_ENABLED: "true",
    OPENAI_API_KEY: validApiKey,
    OPENAI_MODEL: "test-model",
    OPENAI_TOKENIZER_ENCODING: "o200k_base",
  } as NodeJS.ProcessEnv);

  assert.equal(unknown, undefined);
  assert.equal(missingGeminiCredentials, undefined);
});

test("accepts legacy OpenAI flag outside production but leaves all analysis providers off in production", () => {
  const legacy = createConfiguredAnalysisService({
    NODE_ENV: "development",
    OPENAI_ANALYSIS_ENABLED: "true",
    OPENAI_API_KEY: validApiKey,
    OPENAI_MODEL: "test-model",
    OPENAI_TOKENIZER_ENCODING: "o200k_base",
  } as NodeJS.ProcessEnv);
  assert.equal(typeof legacy?.analyze, "function");

  for (const environment of [
    {
      AI_ANALYSIS_ENABLED: "true",
      AI_PROVIDER: "openai",
      OPENAI_API_KEY: validApiKey,
      OPENAI_MODEL: "test-model",
      OPENAI_TOKENIZER_ENCODING: "o200k_base",
    },
    {
      AI_ANALYSIS_ENABLED: "true",
      AI_PROVIDER: "gemini",
      GEMINI_API_KEY: "test-gemini-key-with-at-least-32-characters",
      GEMINI_MODEL: "gemini-2.5-flash-lite",
    },
    { AI_ANALYSIS_ENABLED: "true", AI_PROVIDER: "mock" },
  ]) {
    assert.equal(createConfiguredAnalysisService({
      ...environment,
      NODE_ENV: "production",
    } as NodeJS.ProcessEnv), undefined);
  }
});

test("honors configurable input and output budgets and rejects invalid budget configuration", async () => {
  const limitedService = createConfiguredAnalysisService({
    NODE_ENV: "development",
    AI_ANALYSIS_ENABLED: "true",
    AI_PROVIDER: "mock",
    AI_MAX_INPUT_TOKENS: "10",
  } as NodeJS.ProcessEnv);
  assert.equal(typeof limitedService?.analyze, "function");
  await assert.rejects(limitedService!.analyze({
    jobDescription: "A job description that exceeds the configured tiny token budget",
    resume: "A resume that exceeds the configured tiny token budget",
    dataNoticeAcknowledged: true,
  }));

  assert.equal(createConfiguredAnalysisService({
    NODE_ENV: "development",
    AI_ANALYSIS_ENABLED: "true",
    AI_PROVIDER: "mock",
    AI_MAX_OUTPUT_TOKENS: "0",
  } as NodeJS.ProcessEnv), undefined);
});
