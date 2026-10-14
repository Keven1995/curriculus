import assert from "node:assert/strict";
import test from "node:test";
import { validateDocumentRequest } from "./document-request.js";

test("accepts approved suggestion IDs with an optional bounded user-edited final resume", () => {
  assert.deepEqual(validateDocumentRequest({ approvedSuggestionIds: ["experience", "skills"] }), {
    success: true,
    data: { approvedSuggestionIds: ["experience", "skills"] },
  });
  assert.deepEqual(validateDocumentRequest({ approvedSuggestionIds: [] }), {
    success: true,
    data: { approvedSuggestionIds: [] },
  });
  assert.deepEqual(validateDocumentRequest({
    approvedSuggestionIds: ["experience"],
    finalResumeText: "Currículo revisado manualmente.",
  }), {
    success: true,
    data: { approvedSuggestionIds: ["experience"], finalResumeText: "Currículo revisado manualmente." },
  });
});

test("rejects unknown fields, malformed final text, malformed IDs, duplicates, and oversized selections", () => {
  assert.deepEqual(validateDocumentRequest({ approvedSuggestionIds: [], resume: "forged content" }), { success: false });
  assert.deepEqual(validateDocumentRequest({ approvedSuggestionIds: [], finalResumeText: "\u0000bad" }), { success: false });
  assert.deepEqual(validateDocumentRequest({ approvedSuggestionIds: [], finalResumeText: " " }), { success: false });
  assert.deepEqual(validateDocumentRequest({ approvedSuggestionIds: [], finalResumeText: "x".repeat(80_001) }), { success: false });
  assert.deepEqual(validateDocumentRequest({ approvedSuggestionIds: [], finalResumeText: 123 }), { success: false });
  assert.deepEqual(validateDocumentRequest({ approvedSuggestionIds: [" "] }), { success: false });
  assert.deepEqual(validateDocumentRequest({ approvedSuggestionIds: ["same", "same"] }), { success: false });
  assert.deepEqual(validateDocumentRequest({ approvedSuggestionIds: Array.from({ length: 101 }, (_, i) => `id-${i}`) }), { success: false });
});
