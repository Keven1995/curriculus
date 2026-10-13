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

test("does not pretend that a valid request has been analyzed", async (context) => {
  const app = createApp();
  context.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/analyses",
    payload: validRequest,
  });

  assert.equal(response.statusCode, 501);
  assert.equal(response.json().error.code, "ANALYSIS_NOT_IMPLEMENTED");
  assert.equal(response.body.includes(validRequest.resume), false);
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
