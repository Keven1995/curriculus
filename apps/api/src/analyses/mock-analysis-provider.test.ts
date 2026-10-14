import assert from "node:assert/strict";
import test from "node:test";
import { parseAnalysisOutput } from "./analysis-output.js";
import { MOCK_ANALYSIS_FIXTURE, MockAnalysisProvider } from "./mock-analysis-provider.js";

const request = {
  instructions: "ignored by deterministic mock",
  responseSchema: {},
  maxOutputTokens: 4_000,
};

test("returns deterministic fixture-based analysis covering all requirement statuses", async () => {
  const provider = new MockAnalysisProvider();
  const generated = await provider.generate({
    ...request,
    input: JSON.stringify(MOCK_ANALYSIS_FIXTURE),
  });
  const repeated = await provider.generate({
    ...request,
    input: JSON.stringify(MOCK_ANALYSIS_FIXTURE),
  });

  assert.deepEqual(generated, repeated);
  assert.deepEqual(generated.inputTokens, 0);
  assert.deepEqual(generated.outputTokens, 0);
  const validation = parseAnalysisOutput(JSON.parse(generated.outputText), MOCK_ANALYSIS_FIXTURE.resume);
  assert.equal(validation.success, true);
  if (validation.success) {
    assert.deepEqual(
      validation.data.jobRequirements.map(({ status }) => status),
      ["demonstrated", "partially_demonstrated", "not_demonstrated"],
    );
    assert.deepEqual(
      validation.data.suggestions.map(({ category }) => category),
      ["job_alignment", "proofreading"],
    );
  }
});

test("does not invent results for arbitrary resume or job content", async () => {
  const provider = new MockAnalysisProvider();
  const generated = await provider.generate({
    ...request,
    input: JSON.stringify({ resume: "Currículo particular", jobDescription: "Vaga particular" }),
  });

  assert.deepEqual(JSON.parse(generated.outputText), {
    jobRequirements: [],
    suggestions: [],
    documentStructure: { sectionOrder: [], suggestionOrder: [] },
  });
});
