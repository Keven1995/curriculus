import assert from "node:assert/strict";
import test from "node:test";
import { deleteSessionData, PrivacyRequestError } from "./privacy-client.js";

test("requests immediate deletion using only the opaque session ID", async () => {
  let requestedUrl = "";
  let requestInit: RequestInit | undefined;

  await deleteSessionData("session-test-id", {
    apiBaseUrl: "https://api.example.test/",
    fetcher: async (url, init) => {
      requestedUrl = String(url);
      requestInit = init;
      return new Response(null, { status: 204 });
    },
  });

  assert.equal(requestedUrl, "https://api.example.test/sessions/session-test-id/data");
  assert.equal(requestInit?.method, "DELETE");
  assert.equal(requestInit?.body, undefined);
});

test("does not hide a failed deletion or expose arbitrary server messages", async () => {
  await assert.rejects(
    deleteSessionData("session-test-id", {
      fetcher: async () => new Response(JSON.stringify({
        error: { code: "DOCUMENT_STORAGE_UNAVAILABLE", message: "private storage path" },
      }), { status: 503 }),
    }),
    (error: Error) => {
      assert.ok(error instanceof PrivacyRequestError);
      assert.equal(error.code, "DOCUMENT_STORAGE_UNAVAILABLE");
      assert.equal(error.message.includes("private storage path"), false);
      return true;
    },
  );
});
