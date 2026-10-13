import assert from "node:assert/strict";
import test from "node:test";
import type { AnalysisOutput } from "../analyses/analysis-output.js";
import { buildFinalResume } from "./document-content.js";

const resume = "Resumo profissional\nDesenvolvi APIs em Java.\nConheço SQL.";
const analysis: AnalysisOutput = {
  jobRequirements: [],
  suggestions: [
    {
      id: "experience",
      section: "Experiência",
      originalText: "Desenvolvi APIs em Java.",
      suggestedText: "Desenvolvi e mantive APIs REST em Java.",
      relatedRequirementIds: [],
      rationale: "Destaca a experiência já informada.",
      sourceFacts: ["Desenvolvi APIs em Java."],
      pointsToConfirm: [],
      sourceRange: { start: 20, end: 44 },
    },
    {
      id: "skills",
      section: "Competências",
      originalText: "Conheço SQL.",
      suggestedText: "Utilizei SQL.",
      relatedRequirementIds: [],
      rationale: "Usa linguagem direta.",
      sourceFacts: ["Conheço SQL."],
      pointsToConfirm: [],
      sourceRange: { start: 45, end: 57 },
    },
  ],
  documentStructure: {
    sectionOrder: ["Experiência", "Competências"],
    suggestionOrder: ["experience", "skills"],
  },
};

test("applies only approved suggestions and preserves every other resume character", () => {
  assert.equal(
    buildFinalResume(resume, analysis, ["experience"]),
    "Resumo profissional\nDesenvolvi e mantive APIs REST em Java.\nConheço SQL.",
  );
});

test("keeps all original text when no suggestions are approved", () => {
  assert.equal(buildFinalResume(resume, analysis, []), resume);
});

test("rejects unknown, duplicate, or inconsistent approved suggestion IDs", () => {
  assert.throws(() => buildFinalResume(resume, analysis, ["unknown"]), /aprovações/i);
  assert.throws(() => buildFinalResume(resume, analysis, ["experience", "experience"]), /aprovações/i);
  assert.throws(
    () => buildFinalResume("Currículo alterado", analysis, ["experience"]),
    /origem armazenada/i,
  );
});
