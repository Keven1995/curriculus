import { validateFinalResumeText } from "./document-content.js";

export type DocumentRequestValidation =
  | { success: true; data: { approvedSuggestionIds: string[]; finalResumeText?: string } }
  | { success: false };

const MAX_APPROVED_SUGGESTIONS = 100;
const MAX_SUGGESTION_ID_LENGTH = 128;

export const DOCUMENT_REQUEST_LIMITS = {
  maximumBodyBytes: 384 * 1024,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateDocumentRequest(input: unknown): DocumentRequestValidation {
  if (!isRecord(input)) return { success: false };
  const hasFinalResumeText = Object.hasOwn(input, "finalResumeText");
  if (
    Object.keys(input).length !== (hasFinalResumeText ? 2 : 1) ||
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
  if (!hasFinalResumeText) return { success: true, data: { approvedSuggestionIds } };
  const finalResumeText = validateFinalResumeText(input.finalResumeText);
  if (finalResumeText === undefined) return { success: false };
  return { success: true, data: { approvedSuggestionIds, finalResumeText } };
}
