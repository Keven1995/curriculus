import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "./app.js";

const validRequest = {
  jobDescription: "Vaga de pessoa desenvolvedora",
  resume: "Experiência profissional em desenvolvimento",
  dataNoticeAcknowledged: true,
};

test("keeps the health endpoint available", async (context) => {
  const app = createApp();
  context.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/health" });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    status: "ok",
    service: "curriculus-api",
  });
});

test("returns safe field errors for invalid analysis input", async (context) => {
  const app = createApp();
  context.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/analyses",
    payload: {
      jobDescription: "",
      resume: { privateContent: "do-not-echo-this" },
      dataNoticeAcknowledged: true,
    },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, "INVALID_REQUEST");
  assert.equal(response.body.includes("do-not-echo-this"), false);
});

test("reports unavailable configuration without echoing the submitted content", async (context) => {
  const app = createApp({ analysisService: null });
  context.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/analyses",
    payload: validRequest,
  });

  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, "ANALYSIS_NOT_CONFIGURED");
  assert.equal(response.body.includes(validRequest.resume), false);
});

test("runs the injected analysis service exactly once", async (context) => {
  let calls = 0;
  const app = createApp({
    analysisService: {
      async analyze() {
        calls += 1;
        return {
          analysis: {
            jobRequirements: [],
            suggestions: [],
            documentStructure: { sectionOrder: [], suggestionOrder: [] },
          },
          usage: {
            inputTokens: 123,
            outputTokens: 456,
            totalTokens: 579,
            estimatedCostUsd: null,
          },
        };
      },
    },
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/analyses",
    payload: validRequest,
  });

  assert.equal(response.statusCode, 200);
  assert.equal(calls, 1);
  assert.equal(response.json().usage.totalTokens, 579);
});

test("requires pasted job text before any provider call", async (context) => {
  let calls = 0;
  const app = createApp({
    analysisService: {
      async analyze() {
        calls += 1;
        throw new Error("must not be called");
      },
    },
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/analyses",
    payload: {
      jobUrl: "https://example.com/job",
      resume: validRequest.resume,
      dataNoticeAcknowledged: true,
    },
  });

  assert.equal(response.statusCode, 422);
  assert.equal(response.json().error.code, "JOB_DESCRIPTION_REQUIRED");
  assert.equal(calls, 0);
});

test("rejects request bodies larger than 256 KiB", async (context) => {
  const app = createApp();
  context.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/analyses",
    payload: {
      jobDescription: "vaga",
      resume: "r".repeat(270_000),
      dataNoticeAcknowledged: true,
    },
  });

  assert.equal(response.statusCode, 413);
  assert.equal(response.json().error.code, "PAYLOAD_TOO_LARGE");
  assert.equal(response.body.includes("rrrrrrrr"), false);
});
