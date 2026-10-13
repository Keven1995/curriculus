import assert from "node:assert/strict";
import test from "node:test";
import { createConfiguredAnalysisService } from "./configured-analysis-service.js";

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
