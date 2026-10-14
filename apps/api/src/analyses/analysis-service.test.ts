import assert from "node:assert/strict";
import test from "node:test";
import { createAnalysisService } from "./analysis-service.js";
import {
  AnalysisInputTokenLimitError,
  InvalidAnalysisOutputError,
  AnalysisUsageLimitError,
  JobDescriptionRequiredError,
} from "./analysis-errors.js";

const analysisOutput = {
  jobRequirements: [
    {
      id: "req-1",
      requirement: "Experiência com Java",
      status: "demonstrated",
      evidence: ["Java"],
      pointsToConfirm: [],
    },
  ],
  suggestions: [
    {
      id: "suggestion-1",
      category: "job_alignment",
      section: "Experiência",
      originalText: "Trabalhei com Java para construir APIs REST.",
      suggestedText: "Desenvolvi APIs REST com Java.",
      relatedRequirementIds: ["req-1"],
      rationale: "Destaca a experiência relacionada à vaga.",
      sourceFacts: ["Java", "APIs REST"],
      pointsToConfirm: [],
    },
  ],
  documentStructure: {
    sectionOrder: ["Experiência"],
    suggestionOrder: ["suggestion-1"],
  },
};

const input = {
  jobDescription: "Vaga para pessoa desenvolvedora com experiência em Java.",
  resume: "Trabalhei com Java para construir APIs REST.",
  dataNoticeAcknowledged: true as const,
};

function createFakeProvider(outputText = JSON.stringify(analysisOutput)) {
  const calls: unknown[] = [];
  return {
    calls,
    provider: {
      async generate(request: unknown) {
        calls.push(request);
        return { outputText, inputTokens: 100, outputTokens: 250 };
      },
    },
  };
}

test("makes exactly one model call with a structured-output budget", async () => {
  const fake = createFakeProvider();
  const service = createAnalysisService({
    provider: fake.provider,
    tokenCounter: { count: () => 500 },
    maxInputTokens: 30_000,
    maxOutputTokens: 4_000,
  });

  const result = await service.analyze(input);

  assert.equal(fake.calls.length, 1);
  assert.equal((fake.calls[0] as { maxOutputTokens: number }).maxOutputTokens, 4_000);
  assert.equal(result.usage.inputTokens, 100);
  assert.equal(result.usage.outputTokens, 250);
  assert.equal(result.analysis.suggestions.length, 1);
});

test("blocks input beyond the approved token budget before calling the model", async () => {
  const fake = createFakeProvider();
  const service = createAnalysisService({
    provider: fake.provider,
    tokenCounter: { count: () => 30_001 },
    maxInputTokens: 30_000,
    maxOutputTokens: 4_000,
  });

  await assert.rejects(service.analyze(input), AnalysisInputTokenLimitError);
  assert.equal(fake.calls.length, 0);
});

test("rejects provider-reported output above the approved output budget", async () => {
  const fake = createFakeProvider();
  fake.provider.generate = async (request: unknown) => {
    fake.calls.push(request);
    return { outputText: JSON.stringify(analysisOutput), inputTokens: 100, outputTokens: 4_001 };
  };
  const service = createAnalysisService({
    provider: fake.provider,
    tokenCounter: { count: () => 100 },
    maxInputTokens: 30_000,
    maxOutputTokens: 4_000,
  });

  await assert.rejects(service.analyze(input), AnalysisUsageLimitError);
  assert.equal(fake.calls.length, 1);
});

test("does not send a resume to the model when only a job URL is provided", async () => {
  const fake = createFakeProvider();
  const service = createAnalysisService({
    provider: fake.provider,
    tokenCounter: { count: () => 1 },
    maxInputTokens: 30_000,
    maxOutputTokens: 4_000,
  });

  await assert.rejects(
    service.analyze({
      jobUrl: "https://example.com/job",
      resume: input.resume,
      dataNoticeAcknowledged: true,
    }),
    JobDescriptionRequiredError,
  );
  assert.equal(fake.calls.length, 0);
});

test("does not retry when the model returns malformed or unsupported output", async () => {
  const fake = createFakeProvider("not-json");
  const service = createAnalysisService({
    provider: fake.provider,
    tokenCounter: { count: () => 50 },
    maxInputTokens: 30_000,
    maxOutputTokens: 4_000,
  });

  await assert.rejects(
    service.analyze(input),
    (error: unknown) => error instanceof InvalidAnalysisOutputError && error.validationFailure === "invalid_json",
  );
  assert.equal(fake.calls.length, 1);
});

test("returns only a bounded validation code when JSON does not satisfy the output contract", async () => {
  const fake = createFakeProvider(JSON.stringify({ unexpected: "PRIVATE_MODEL_TEXT" }));
  const service = createAnalysisService({
    provider: fake.provider,
    tokenCounter: { count: () => 50 },
    maxInputTokens: 30_000,
    maxOutputTokens: 4_000,
  });

  await assert.rejects(
    service.analyze(input),
    (error: unknown) => error instanceof InvalidAnalysisOutputError && error.validationFailure === "invalid_root",
  );
});

test("estimates cost only when configured, using provider-reported token usage", async () => {
  const fake = createFakeProvider();
  const service = createAnalysisService({
    provider: fake.provider,
    tokenCounter: { count: () => 100 },
    maxInputTokens: 30_000,
    maxOutputTokens: 4_000,
    pricing: { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.5 },
  });

  const result = await service.analyze(input);

  assert.equal(result.usage.totalTokens, 350);
  assert.equal(result.usage.estimatedCostUsd, 0.000135);
});
