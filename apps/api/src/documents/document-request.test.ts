import assert from "node:assert/strict";
import test from "node:test";
import { validateDocumentRequest } from "./document-request.js";

test("accepts only a list of approved suggestion IDs", () => {
  assert.deepEqual(validateDocumentRequest({ approvedSuggestionIds: ["experience", "skills"] }), {
    success: true,
    data: { approvedSuggestionIds: ["experience", "skills"] },
  });
  assert.deepEqual(validateDocumentRequest({ approvedSuggestionIds: [] }), {
    success: true,
    data: { approvedSuggestionIds: [] },
  });
});

test("rejects client-provided document text, malformed IDs, duplicates, and oversized selections", () => {
  assert.deepEqual(validateDocumentRequest({ approvedSuggestionIds: [], resume: "forged content" }), { success: false });
  assert.deepEqual(validateDocumentRequest({ approvedSuggestionIds: [" "] }), { success: false });
  assert.deepEqual(validateDocumentRequest({ approvedSuggestionIds: ["same", "same"] }), { success: false });
  assert.deepEqual(validateDocumentRequest({ approvedSuggestionIds: Array.from({ length: 101 }, (_, i) => `id-${i}`) }), { success: false });
});
