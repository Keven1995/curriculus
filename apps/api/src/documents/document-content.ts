import type { AnalysisOutput } from "../analyses/analysis-output.js";

export class ApprovedSuggestionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovedSuggestionsError";
  }
}

export function buildFinalResume(
  resume: string,
  analysis: AnalysisOutput,
  approvedSuggestionIds: readonly string[],
): string {
  const approvedIds = new Set(approvedSuggestionIds);
  if (
    approvedIds.size !== approvedSuggestionIds.length ||
    approvedSuggestionIds.some((id) => !analysis.suggestions.some((suggestion) => suggestion.id === id))
  ) {
    throw new ApprovedSuggestionsError("As aprovações não correspondem às sugestões armazenadas.");
  }

  const selected = analysis.suggestions
    .filter((suggestion) => approvedIds.has(suggestion.id))
    .sort((left, right) => left.sourceRange.start - right.sourceRange.start);

  const parts: string[] = [];
  let cursor = 0;
  for (const suggestion of selected) {
    const { start, end } = suggestion.sourceRange;
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < cursor ||
      end <= start ||
      end > resume.length ||
      resume.slice(start, end) !== suggestion.originalText
    ) {
      throw new ApprovedSuggestionsError("Uma sugestão não corresponde à origem armazenada.");
    }

    parts.push(resume.slice(cursor, start), suggestion.suggestedText);
    cursor = end;
  }

  parts.push(resume.slice(cursor));
  return parts.join("");
}
