import assert from "node:assert/strict";
import test from "node:test";
import { parseAnalysisOutput } from "./analysis-output.js";

const resume = "Trabalhei com Java para construir APIs REST.";

const validOutput = {
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
      section: "Experiência",
      originalText: resume,
      suggestedText: "Desenvolvi APIs REST com Java.",
      relatedRequirementIds: ["req-1"],
      rationale: "Torna a experiência relevante mais fácil de identificar.",
      sourceFacts: ["Java", "APIs REST"],
      pointsToConfirm: [],
    },
  ],
  documentStructure: {
    sectionOrder: ["Experiência"],
    suggestionOrder: ["suggestion-1"],
  },
};

test("accepts structured suggestions backed by exact resume excerpts", () => {
  const result = parseAnalysisOutput(validOutput, resume);

  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.suggestions[0]?.suggestedText, "Desenvolvi APIs REST com Java.");
  }
});

test("rejects output that invents source facts", () => {
  const result = parseAnalysisOutput(
    {
      ...validOutput,
      suggestions: [{ ...validOutput.suggestions[0], sourceFacts: ["Kubernetes"] }],
    },
    resume,
  );

  assert.equal(result.success, false);
});

test("rejects current text that is not a unique verbatim excerpt", () => {
  const repeatedResume = `${resume}\n${resume}`;
  const result = parseAnalysisOutput(validOutput, repeatedResume);

  assert.equal(result.success, false);
});

test("requires a point to confirm for requirements not demonstrated by the resume", () => {
  const result = parseAnalysisOutput(
    {
      jobRequirements: [
        {
          id: "req-1",
          requirement: "Experiência com liderança",
          status: "not_demonstrated",
          evidence: [],
          pointsToConfirm: [],
        },
      ],
      suggestions: [],
      documentStructure: { sectionOrder: ["Experiência"], suggestionOrder: [] },
    },
    resume,
  );

  assert.equal(result.success, false);
});

test("rejects invalid references and undeclared output properties", () => {
  const invalidReferences = parseAnalysisOutput(
    {
      ...validOutput,
      suggestions: [
        { ...validOutput.suggestions[0], relatedRequirementIds: ["req-404"] },
      ],
    },
    resume,
  );
  const extraField = parseAnalysisOutput({ ...validOutput, inventedSummary: "new facts" }, resume);

  assert.equal(invalidReferences.success, false);
  assert.equal(extraField.success, false);
});
