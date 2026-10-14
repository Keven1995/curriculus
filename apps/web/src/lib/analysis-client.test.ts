import assert from "node:assert/strict";
import test from "node:test";
import "../test/setup-dom.js";
import {
  approvedSuggestionIds,
  buildResumeWithApprovedSuggestions,
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
        category: "job_alignment",
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
        category: "job_alignment",
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
        jobDescription: "Vaga de exemplo",
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

test("builds a final text from only approved suggestions and ignores stale source ranges", () => {
  const resume = "Desenvolvi APIs.\nGraduação em Sistemas.";
  const secondStart = resume.indexOf("Graduação em Sistemas.");
  const analysis = {
    ...apiResponse.analysis,
    suggestions: [
      apiResponse.analysis.suggestions[0]!,
      {
        ...apiResponse.analysis.suggestions[1]!,
        sourceRange: { start: secondStart, end: secondStart + "Graduação em Sistemas.".length },
      },
    ],
  };
  const decisions = { "suggestion-1": "approved", "suggestion-2": "rejected" } as const;

  assert.equal(
    buildResumeWithApprovedSuggestions(resume, analysis, decisions),
    "Desenvolvi APIs REST.\nGraduação em Sistemas.",
  );
  assert.equal(
    buildResumeWithApprovedSuggestions(resume, analysis, {
      "suggestion-1": "approved",
      "suggestion-2": "approved",
    }),
    "Desenvolvi APIs REST.\nGraduação em Sistemas de Informação.",
  );

  const staleAnalysis = {
    ...analysis,
    suggestions: analysis.suggestions.map((suggestion, index) => index === 1
      ? { ...suggestion, sourceRange: { start: 0, end: 1 } }
      : suggestion),
  };
  assert.equal(
    buildResumeWithApprovedSuggestions(resume, staleAnalysis, {
      "suggestion-1": "rejected",
      "suggestion-2": "approved",
    }),
    resume,
  );
});
