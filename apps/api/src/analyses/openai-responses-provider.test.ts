import assert from "node:assert/strict";
import test from "node:test";
import { AnalysisProviderError } from "./analysis-errors.js";
import { OpenAIResponsesProvider } from "./openai-responses-provider.js";

function responseWith(text: string, status = "completed") {
  return new Response(
    JSON.stringify({
      status,
      output: [{ type: "message", content: [{ type: "output_text", text }] }],
      usage: { input_tokens: 321, output_tokens: 654, total_tokens: 975 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

test("sends one Responses API request with strict JSON Schema and output cap", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const provider = new OpenAIResponsesProvider({
    apiKey: "test-api-key",
    model: "test-model",
    fetcher: async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });
      return responseWith("{\"ok\":true}");
    },
  });

  const result = await provider.generate({
    instructions: "System instructions",
    input: "User content",
    responseSchema: { type: "object" },
    maxOutputTokens: 4_000,
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, "https://api.openai.com/v1/responses");
  assert.equal(new Headers(requests[0]?.init.headers).get("authorization"), "Bearer test-api-key");
  const payload = JSON.parse(String(requests[0]?.init.body));
  assert.equal(payload.model, "test-model");
  assert.equal(payload.store, false);
  assert.equal(payload.max_output_tokens, 4_000);
  assert.equal(payload.text.format.type, "json_schema");
  assert.equal(payload.text.format.strict, true);
  assert.deepEqual(result, {
    outputText: "{\"ok\":true}",
    inputTokens: 321,
    outputTokens: 654,
  });
});

test("does not expose provider response bodies in errors or retry failed calls", async () => {
  let calls = 0;
  const provider = new OpenAIResponsesProvider({
    apiKey: "test-api-key",
    model: "test-model",
    fetcher: async () => {
      calls += 1;
      return new Response("private-provider-error", { status: 500 });
    },
  });

  await assert.rejects(
    provider.generate({
      instructions: "instructions",
      input: "private resume text",
      responseSchema: {},
      maxOutputTokens: 4_000,
    }),
    (error: Error) => {
      assert.equal(error.message.includes("private-provider-error"), false);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("classifies common OpenAI HTTP failures without retaining provider messages or secrets", async () => {
  const cases = [
    { status: 401, code: "invalid_api_key", reason: "authentication_failed" },
    { status: 429, code: "insufficient_quota", reason: "quota_exhausted" },
    { status: 429, code: "rate_limit_exceeded", reason: "rate_limited" },
    { status: 404, code: "model_not_found", reason: "model_unavailable" },
    { status: 500, code: "internal_error", reason: "provider_server_error" },
  ] as const;

  for (const scenario of cases) {
    const provider = new OpenAIResponsesProvider({
      apiKey: "sk-secret-provider-credential",
      model: "private-model-name",
      fetcher: async () => new Response(JSON.stringify({
        error: {
          code: scenario.code,
          message: "PRIVATE_RESUME private-model-name sk-secret-provider-credential",
        },
      }), {
        status: scenario.status,
        headers: { "content-type": "application/json", "x-request-id": "req_safe-id-123" },
      }),
    });

    await assert.rejects(
      provider.generate({
        instructions: "instructions",
        input: "PRIVATE_RESUME",
        responseSchema: {},
        maxOutputTokens: 4_000,
      }),
      (error: unknown) => {
        assert.ok(error instanceof AnalysisProviderError);
        assert.equal(error.message.includes("PRIVATE_RESUME"), false);
        assert.equal(error.message.includes("sk-secret-provider-credential"), false);
        assert.deepEqual(error.diagnostics, {
          reason: scenario.reason,
          httpStatus: scenario.status,
          requestId: "req_safe-id-123",
        });
        return true;
      },
    );
  }
});

test("maps timeouts and unsafe or unparseable provider error details to bounded diagnostics", async () => {
  const timeoutProvider = new OpenAIResponsesProvider({
    apiKey: "test-api-key",
    model: "test-model",
    fetcher: async () => { throw new DOMException("sensitive timeout detail", "TimeoutError"); },
  });
  await assert.rejects(
    timeoutProvider.generate({ instructions: "x", input: "secret", responseSchema: {}, maxOutputTokens: 10 }),
    (error: unknown) => error instanceof AnalysisProviderError && error.diagnostics.reason === "timeout",
  );

  const malformedErrorProvider = new OpenAIResponsesProvider({
    apiKey: "test-api-key",
    model: "test-model",
    fetcher: async () => new Response("private error body", {
      status: 429,
      headers: { "x-request-id": `req_${"x".repeat(120)}` },
    }),
  });
  await assert.rejects(
    malformedErrorProvider.generate({ instructions: "x", input: "secret", responseSchema: {}, maxOutputTokens: 10 }),
    (error: unknown) => {
      assert.ok(error instanceof AnalysisProviderError);
      assert.equal(error.diagnostics.reason, "rate_limited");
      assert.equal(error.diagnostics.httpStatus, 429);
      assert.equal(error.diagnostics.requestId, undefined);
      assert.equal(error.message.includes("private error body"), false);
      return true;
    },
  );
});

test("rejects incomplete responses and reports no generated text", async () => {
  const provider = new OpenAIResponsesProvider({
    apiKey: "test-api-key",
    model: "test-model",
    fetcher: async () => responseWith("partial", "incomplete"),
  });

  await assert.rejects(
    provider.generate({
      instructions: "instructions",
      input: "content",
      responseSchema: {},
      maxOutputTokens: 4_000,
    }),
  );
});
