import assert from "node:assert/strict";
import test from "node:test";
import "../test/setup-dom.js";
import {
  approvedSuggestionIds,
  isAnalysisApiResponse,
  requestAnalysis,
  summarizeDecisions,
  updateSuggestionDecision,
  type AnalysisApiResponse,
} from "./analysis-client";

const apiResponse: AnalysisApiResponse = {
  sessionId: "session-test-id",
  expiresAt: "2026-01-02T00:00:00.000Z",
  analysis: {
    jobRequirements: [],
    suggestions: [
      {
        id: "suggestion-1",
        section: "Experiência",
        originalText: "Desenvolvi APIs.",
        suggestedText: "Desenvolvi APIs REST.",
        relatedRequirementIds: [],
        rationale: "Explicita o tipo de API descrito.",
        sourceFacts: ["Desenvolvi APIs."],
        pointsToConfirm: [],
        sourceRange: { start: 0, end: 16 },
      },
      {
        id: "suggestion-2",
        section: "Formação",
        originalText: "Graduação em Sistemas.",
        suggestedText: "Graduação em Sistemas de Informação.",
        relatedRequirementIds: [],
        rationale: "Detalha a formação informada.",
        sourceFacts: ["Graduação em Sistemas."],
        pointsToConfirm: ["Confirme o nome oficial do curso."],
        sourceRange: { start: 20, end: 43 },
      },
    ],
    documentStructure: {
      sectionOrder: ["Experiência", "Formação"],
      suggestionOrder: ["suggestion-1", "suggestion-2"],
    },
  },
  usage: {
    inputTokens: 123,
    outputTokens: 456,
    totalTokens: 579,
    estimatedCostUsd: null,
  },
};

test("accepts a well-formed analysis response and rejects malformed data", () => {
  assert.equal(isAnalysisApiResponse(apiResponse), true);
  assert.equal(isAnalysisApiResponse({ ...apiResponse, analysis: null }), false);
  assert.equal(isAnalysisApiResponse({ ...apiResponse, sessionId: "" }), false);
});

test("posts the validated form and returns the analysis response", async () => {
  let calls = 0;
  let sentBody: Record<string, unknown> | undefined;
  const response = await requestAnalysis(
    {
      jobUrl: "https://example.com/job",
      jobDescription: "Vaga de exemplo",
      resume: "Currículo sintético",
      acknowledged: true,
    },
    {
      apiBaseUrl: "https://api.example.test",
      fetcher: async (url, init) => {
        calls += 1;
        assert.equal(url, "https://api.example.test/analyses");
        assert.equal(init?.method, "POST");
        sentBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify(apiResponse), { status: 201 });
      },
    },
  );

  assert.equal(calls, 1);
  assert.equal(sentBody?.dataNoticeAcknowledged, true);
  assert.equal(sentBody?.resume, "Currículo sintético");
  assert.equal(response.sessionId, "session-test-id");
});

test("maps server validation errors without exposing arbitrary response text", async () => {
  await assert.rejects(
    requestAnalysis(
      {
        jobUrl: "https://example.com/job",
        jobDescription: "",
        resume: "synthetic resume",
        acknowledged: true,
      },
      {
        apiBaseUrl: "https://api.example.test",
        fetcher: async () =>
          new Response(
            JSON.stringify({ error: { code: "JOB_DESCRIPTION_REQUIRED", message: "private text" } }),
            { status: 422 },
          ),
      },
    ),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "JOB_DESCRIPTION_REQUIRED");
      assert.equal(error.message.includes("private text"), false);
      return true;
    },
  );
});

test("tracks local decisions and returns only approved suggestions in document order", () => {
  const first = updateSuggestionDecision({}, "suggestion-1", "approved");
  const decisions = updateSuggestionDecision(first, "suggestion-2", "rejected");

  assert.deepEqual(first, { "suggestion-1": "approved" });
  assert.deepEqual(decisions, {
    "suggestion-1": "approved",
    "suggestion-2": "rejected",
  });
  assert.deepEqual(summarizeDecisions(apiResponse.analysis.suggestions, decisions), {
    approved: 1,
    rejected: 1,
    pending: 0,
  });
  assert.deepEqual(approvedSuggestionIds(apiResponse.analysis, decisions), ["suggestion-1"]);
});
