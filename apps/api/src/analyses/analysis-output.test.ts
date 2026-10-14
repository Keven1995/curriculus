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
      category: "job_alignment",
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

test("normalizes case and PDF whitespace while returning literal source text and offsets", () => {
  const sourceResume = "Atendimento\tpor telefone\ncom Excel avançado.";
  const output = {
    ...validOutput,
    jobRequirements: [{
      ...validOutput.jobRequirements[0],
      evidence: ["ATENDIMENTO por telefone com Excel avançado."],
    }],
    suggestions: [{
      ...validOutput.suggestions[0],
      originalText: "atendimento por telefone com excel avançado.",
      sourceFacts: ["EXCEL    AVANÇADO"],
    }],
  };

  const result = parseAnalysisOutput(output, sourceResume);

  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.jobRequirements[0]?.evidence[0], sourceResume);
    assert.equal(result.data.suggestions[0]?.originalText, sourceResume);
    assert.equal(result.data.suggestions[0]?.sourceFacts[0], "Excel avançado");
    assert.deepEqual(result.data.suggestions[0]?.sourceRange, { start: 0, end: sourceResume.length });
  }
});

test("downgrades an unsupported requirement and omits only suggestions tied to it", () => {
  const result = parseAnalysisOutput({
    ...validOutput,
    jobRequirements: [{
      ...validOutput.jobRequirements[0],
      status: "demonstrated",
      evidence: ["Experiência liderando equipes"],
      pointsToConfirm: [],
    }],
  }, resume);

  assert.equal(result.success, true);
  if (result.success) {
    assert.deepEqual(result.data.jobRequirements[0], {
      id: "req-1",
      requirement: "Experiência com Java",
      status: "not_demonstrated",
      evidence: [],
      pointsToConfirm: ["Confirme se você possui experiência ou qualificação relacionada a: Experiência com Java."],
    });
    assert.equal(result.data.suggestions.length, 0);
  }
});

test("drops an unsupported suggestion without discarding supported suggestions", () => {
  const supported = { ...validOutput.suggestions[0], id: "suggestion-supported" };
  const unsupported = {
    ...validOutput.suggestions[0],
    id: "suggestion-unsupported",
    suggestedText: "Administrei Kubernetes.",
    sourceFacts: ["Kubernetes"],
  };
  const result = parseAnalysisOutput({
    ...validOutput,
    suggestions: [unsupported, supported],
    documentStructure: { sectionOrder: [], suggestionOrder: ["missing-id"] },
  }, resume);

  assert.equal(result.success, true);
  if (result.success) {
    assert.deepEqual(result.data.suggestions.map(({ id }) => id), ["suggestion-supported"]);
    assert.deepEqual(result.data.documentStructure, {
      sectionOrder: ["Experiência"],
      suggestionOrder: ["suggestion-supported"],
    });
  }
});

test("accepts a proofreading correction without linking it to job requirements or facts", () => {
  const sourceResume = "Tenho experiencia com documentacao tecnica.";
  const result = parseAnalysisOutput({
    jobRequirements: [],
    suggestions: [{
      id: "proofreading-1",
      category: "proofreading",
      section: "Ortografia e pontuação",
      originalText: "experiencia com documentacao tecnica",
      suggestedText: "experiência com documentação técnica",
      relatedRequirementIds: [],
      rationale: "Corrige a acentuação conforme a ortografia brasileira.",
      sourceFacts: [],
      pointsToConfirm: [],
    }],
    documentStructure: {
      sectionOrder: ["Ortografia e pontuação"],
      suggestionOrder: ["proofreading-1"],
    },
  }, sourceResume);

  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.suggestions[0]?.category, "proofreading");
    assert.equal(result.data.suggestions[0]?.originalText, "experiencia com documentacao tecnica");
    assert.deepEqual(result.data.suggestions[0]?.relatedRequirementIds, []);
    assert.deepEqual(result.data.suggestions[0]?.sourceFacts, []);
  }
});

test("omits ambiguous and overlapping suggestions individually", () => {
  const wholeResumeSuggestion = { ...validOutput.suggestions[0], id: "whole" };
  const overlappingSuggestion = {
    ...validOutput.suggestions[0],
    id: "overlap",
    originalText: "Java",
    suggestedText: "Java e liderança",
    sourceFacts: ["Java"],
  };
  const ambiguousResume = `${resume}\n${resume}`;
  const ambiguous = parseAnalysisOutput(validOutput, ambiguousResume);
  const overlapping = parseAnalysisOutput({
    ...validOutput,
    suggestions: [wholeResumeSuggestion, overlappingSuggestion],
  }, resume);

  assert.equal(ambiguous.success, true);
  if (ambiguous.success) assert.equal(ambiguous.data.suggestions.length, 0);
  assert.equal(overlapping.success, true);
  if (overlapping.success) assert.deepEqual(overlapping.data.suggestions.map(({ id }) => id), ["whole"]);
});

test("provides a confirmation point for requirements not demonstrated by the resume", () => {
  const result = parseAnalysisOutput({
    ...validOutput,
    jobRequirements: [{
      id: "req-1",
      requirement: "Experiência com liderança",
      status: "not_demonstrated",
      evidence: [],
      pointsToConfirm: [],
    }],
    suggestions: [],
    documentStructure: { sectionOrder: [], suggestionOrder: [] },
  }, resume);

  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.jobRequirements[0]?.status, "not_demonstrated");
    assert.equal(result.data.jobRequirements[0]?.pointsToConfirm.length, 1);
  }
});

test("rejects an invalid root but tolerates invalid document ordering", () => {
  const extraField = parseAnalysisOutput({ ...validOutput, inventedSummary: "new facts" }, resume);
  const invalidOrder = parseAnalysisOutput({
    ...validOutput,
    documentStructure: { sectionOrder: "wrong", suggestionOrder: null },
  }, resume);

  assert.equal(extraField.success, false);
  assert.equal(invalidOrder.success, true);
  if (invalidOrder.success) {
    assert.deepEqual(invalidOrder.data.documentStructure.suggestionOrder, ["suggestion-1"]);
  }
});
