import assert from "node:assert/strict";
import test from "node:test";
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
