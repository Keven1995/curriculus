export type DocumentRequestValidation =
  | { success: true; data: { approvedSuggestionIds: string[] } }
  | { success: false };

const MAX_APPROVED_SUGGESTIONS = 100;
const MAX_SUGGESTION_ID_LENGTH = 128;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateDocumentRequest(input: unknown): DocumentRequestValidation {
  if (
    !isRecord(input) ||
    Object.keys(input).length !== 1 ||
    !Object.hasOwn(input, "approvedSuggestionIds") ||
    !Array.isArray(input.approvedSuggestionIds) ||
    input.approvedSuggestionIds.length > MAX_APPROVED_SUGGESTIONS ||
    !input.approvedSuggestionIds.every(
      (id) => typeof id === "string" && id.trim().length > 0 && id.length <= MAX_SUGGESTION_ID_LENGTH,
    )
  ) {
    return { success: false };
  }

  const approvedSuggestionIds = input.approvedSuggestionIds as string[];
  if (new Set(approvedSuggestionIds).size !== approvedSuggestionIds.length) return { success: false };
  return { success: true, data: { approvedSuggestionIds } };
}
