import assert from "node:assert/strict";
import test from "node:test";
import { AnalysisProviderError, InvalidAnalysisOutputError } from "./analysis-errors.js";
import { createAnalysisService } from "./analysis-service.js";
import { GeminiAnalysisProvider, toGeminiResponseSchema } from "./gemini-analysis-provider.js";

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: { name: { type: "string" } },
};

function successfulResponse(outputText: string, status = 200) {
  return new Response(JSON.stringify({
    candidates: [{
      finishReason: "STOP",
      content: { parts: [{ text: outputText }] },
    }],
    usageMetadata: {
      promptTokenCount: 321,
      candidatesTokenCount: 654,
      thoughtsTokenCount: 5,
      totalTokenCount: 980,
    },
  }), { status, headers: { "content-type": "application/json" } });
}

const generateRequest = {
  instructions: "System instructions",
  input: "Synthetic resume and job content",
  responseSchema: schema,
  maxOutputTokens: 4_000,
};

test("sends Gemini structured-output request with key in backend header and returns measured usage", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const provider = new GeminiAnalysisProvider({
    apiKey: "test-gemini-key-with-at-least-32-characters",
    model: "gemini-2.5-flash-lite",
    fetcher: async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });
      return successfulResponse('{"name":"synthetic"}');
    },
  });

  const result = await provider.generate(generateRequest);
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0]?.url,
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent",
  );
  assert.equal(new Headers(requests[0]?.init.headers).get("x-goog-api-key"), "test-gemini-key-with-at-least-32-characters");
  assert.equal(requests[0]?.url.includes("test-gemini-key"), false);
  const payload = JSON.parse(String(requests[0]?.init.body));
  assert.equal(payload.systemInstruction.parts[0].text, generateRequest.instructions);
  assert.equal(payload.contents[0].parts[0].text, generateRequest.input);
  assert.equal(payload.generationConfig.responseMimeType, "application/json");
  assert.equal(payload.generationConfig.maxOutputTokens, 4_000);
  assert.equal(payload.generationConfig.responseSchema.additionalProperties, undefined);
  assert.deepEqual(result, {
    outputText: '{"name":"synthetic"}',
    inputTokens: 321,
    outputTokens: 659,
  });
});

test("adapts nested JSON Schema by omitting OpenAI-only strictness fields", () => {
  assert.deepEqual(toGeminiResponseSchema({
    type: "object",
    additionalProperties: false,
    strict: true,
    properties: {
      results: {
        type: "array",
        items: { type: "object", additionalProperties: false, properties: { value: { type: "string" } } },
      },
    },
  }), {
    type: "object",
    properties: {
      results: {
        type: "array",
        items: { type: "object", properties: { value: { type: "string" } } },
      },
    },
  });
});

test("maps upstream failures to bounded diagnostics without retaining error body or user content", async () => {
  const cases = [
    { status: 401, providerStatus: "UNAUTHENTICATED", expected: "authentication_failed" },
    { status: 403, providerStatus: "PERMISSION_DENIED", expected: "permission_denied" },
    { status: 429, providerStatus: "RESOURCE_EXHAUSTED", expected: "quota_exhausted" },
    { status: 429, providerStatus: "RATE_LIMIT_EXCEEDED", expected: "rate_limited" },
    { status: 503, providerStatus: "UNAVAILABLE", expected: "provider_server_error" },
  ] as const;

  for (const scenario of cases) {
    const provider = new GeminiAnalysisProvider({
      apiKey: "private-gemini-key-with-at-least-32-characters",
      model: "private-model",
      fetcher: async () => new Response(JSON.stringify({
        error: {
          status: scenario.providerStatus,
          message: "PRIVATE_RESUME private-model private-gemini-key-with-at-least-32-characters",
        },
      }), {
        status: scenario.status,
        headers: { "content-type": "application/json", "x-goog-request-id": "gemini-safe-request-1" },
      }),
    });

    await assert.rejects(
      provider.generate(generateRequest),
      (error: unknown) => {
        assert.ok(error instanceof AnalysisProviderError);
        assert.equal(error.message.includes("PRIVATE_RESUME"), false);
        assert.equal(error.message.includes("private-gemini-key"), false);
        assert.deepEqual(error.diagnostics, {
          provider: "gemini",
          reason: scenario.expected,
          httpStatus: scenario.status,
          requestId: "gemini-safe-request-1",
        });
        return true;
      },
    );
  }
});

test("maps timeouts and rejects malformed responses or missing usage rather than reporting zero", async () => {
  const timeoutProvider = new GeminiAnalysisProvider({
    apiKey: "test-gemini-key-with-at-least-32-characters",
    model: "test-model",
    fetcher: async () => { throw new DOMException("sensitive timeout detail", "TimeoutError"); },
  });
  await assert.rejects(
    timeoutProvider.generate(generateRequest),
    (error: unknown) => error instanceof AnalysisProviderError && error.diagnostics.reason === "timeout",
  );

  const missingUsageProvider = new GeminiAnalysisProvider({
    apiKey: "test-gemini-key-with-at-least-32-characters",
    model: "test-model",
    fetcher: async () => new Response(JSON.stringify({
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: "{}" }] } }],
      usageMetadata: { promptTokenCount: 2 },
    }), { status: 200 }),
  });
  await assert.rejects(
    missingUsageProvider.generate(generateRequest),
    (error: unknown) => error instanceof AnalysisProviderError && error.diagnostics.reason === "invalid_provider_response",
  );
});

test("lets the existing analysis validator reject JSON outside the application schema", async () => {
  const provider = new GeminiAnalysisProvider({
    apiKey: "test-gemini-key-with-at-least-32-characters",
    model: "test-model",
    fetcher: async () => successfulResponse("{\"unexpected\":true}"),
  });
  const service = createAnalysisService({
    provider,
    tokenCounter: { count: () => 10 },
    maxInputTokens: 30_000,
    maxOutputTokens: 4_000,
  });

  await assert.rejects(
    service.analyze({
      jobDescription: "Synthetic job",
      resume: "Synthetic resume",
      dataNoticeAcknowledged: true,
    }),
    InvalidAnalysisOutputError,
  );
});
