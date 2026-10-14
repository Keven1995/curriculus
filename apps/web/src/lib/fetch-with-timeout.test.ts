import assert from "node:assert/strict";
import test from "node:test";
import { fetchWithTimeout, RequestTimeoutError } from "./fetch-with-timeout";

test("aborts a request that exceeds its deadline even when a test transport ignores AbortSignal", async () => {
  const fetcher = (() => new Promise<Response>(() => undefined)) as typeof fetch;
  await assert.rejects(
    fetchWithTimeout(fetcher, "https://example.test", {}, 5),
    RequestTimeoutError,
  );
});

test("keeps successful response bodies readable and clears its deadline", async () => {
  let signal: AbortSignal | undefined;
  const fetcher = ((_input: RequestInfo | URL, init?: RequestInit) => {
    signal = init?.signal as AbortSignal | undefined;
    return Promise.resolve(new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } }));
  }) as typeof fetch;

  const response = await fetchWithTimeout(fetcher, "https://example.test", {}, 100);
  assert.equal(response.status, 200);
  assert.equal(signal?.aborted, false);
  assert.deepEqual(await response.json(), { ok: true });
});

test("applies the deadline to a response body that stalls after headers arrive", async () => {
  const fetcher = (() => Promise.resolve(new Response(new ReadableStream<Uint8Array>({ pull() {} })))) as typeof fetch;
  await assert.rejects(
    fetchWithTimeout(fetcher, "https://example.test", {}, 5),
    RequestTimeoutError,
  );
});
