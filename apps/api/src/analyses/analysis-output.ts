export type RequirementStatus =
  | "demonstrated"
  | "partially_demonstrated"
  | "not_demonstrated";

export type JobRequirement = {
  id: string;
  requirement: string;
  status: RequirementStatus;
  evidence: string[];
  pointsToConfirm: string[];
};

export type SuggestionCategory = "job_alignment" | "proofreading";

export type AnalysisSuggestion = {
  id: string;
  category: SuggestionCategory;
  section: string;
  originalText: string;
  suggestedText: string;
  relatedRequirementIds: string[];
  rationale: string;
  sourceFacts: string[];
  pointsToConfirm: string[];
  sourceRange: { start: number; end: number };
};

export type AnalysisOutput = {
  jobRequirements: JobRequirement[];
  suggestions: AnalysisSuggestion[];
  documentStructure: {
    sectionOrder: string[];
    suggestionOrder: string[];
  };
};

export type AnalysisOutputValidation =
  | { success: true; data: AnalysisOutput }
  | { success: false; issues: AnalysisOutputIssueCode[] };

export type AnalysisOutputIssueCode =
  | "invalid_root"
  | "invalid_collections";

export const ANALYSIS_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["jobRequirements", "suggestions", "documentStructure"],
  properties: {
    jobRequirements: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "requirement", "status", "evidence", "pointsToConfirm"],
        properties: {
          id: { type: "string" },
          requirement: { type: "string" },
          status: {
            type: "string",
            enum: ["demonstrated", "partially_demonstrated", "not_demonstrated"],
          },
          evidence: { type: "array", items: { type: "string" } },
          pointsToConfirm: { type: "array", items: { type: "string" } },
        },
      },
    },
    suggestions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "category",
          "section",
          "originalText",
          "suggestedText",
          "relatedRequirementIds",
          "rationale",
          "sourceFacts",
          "pointsToConfirm",
        ],
        properties: {
          id: { type: "string" },
          category: { type: "string", enum: ["job_alignment", "proofreading"] },
          section: { type: "string" },
          originalText: { type: "string" },
          suggestedText: { type: "string" },
          relatedRequirementIds: { type: "array", items: { type: "string" } },
          rationale: { type: "string" },
          sourceFacts: { type: "array", items: { type: "string" } },
          pointsToConfirm: { type: "array", items: { type: "string" } },
        },
      },
    },
    documentStructure: {
      type: "object",
      additionalProperties: false,
      required: ["sectionOrder", "suggestionOrder"],
      properties: {
        sectionOrder: { type: "array", items: { type: "string" } },
        suggestionOrder: { type: "array", items: { type: "string" } },
      },
    },
  },
} satisfies Record<string, unknown>;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: UnknownRecord, expected: string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => key in value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(nonEmptyString);
}

type SourceRange = { start: number; end: number };
type NormalizedText = { symbols: string[]; ranges: SourceRange[] };

/** Normalize PDF typography while keeping offsets into the original source. */
function normalizeWithSourceRanges(value: string): NormalizedText {
  const symbols: string[] = [];
  const ranges: SourceRange[] = [];

  for (const match of value.matchAll(/\P{M}\p{M}*|\p{M}+/gu)) {
    const token = match[0];
    const start = match.index ?? 0;
    const end = start + token.length;
    const normalizedToken = token.normalize("NFKC").toLowerCase();

    for (const symbol of Array.from(normalizedToken)) {
      if (/^\s+$/u.test(symbol)) {
        if (symbols.at(-1) === " ") {
          ranges[ranges.length - 1]!.end = end;
        } else {
          symbols.push(" ");
          ranges.push({ start, end });
        }
      } else {
        symbols.push(symbol);
        ranges.push({ start, end });
      }
    }
  }

  if (symbols[0] === " ") {
    symbols.shift();
    ranges.shift();
  }
  if (symbols.at(-1) === " ") {
    symbols.pop();
    ranges.pop();
  }
  return { symbols, ranges };
}

function findSourceMatches(source: NormalizedText, candidate: string): SourceRange[] {
  const candidateSymbols = normalizeWithSourceRanges(candidate).symbols;
  if (candidateSymbols.length === 0 || candidateSymbols.length > source.symbols.length) return [];

  const prefix = new Array<number>(candidateSymbols.length).fill(0);
  for (let index = 1, matched = 0; index < candidateSymbols.length;) {
    if (candidateSymbols[index] === candidateSymbols[matched]) {
      prefix[index] = ++matched;
      index += 1;
    } else if (matched > 0) {
      matched = prefix[matched - 1]!;
    } else {
      index += 1;
    }
  }

  const matches: SourceRange[] = [];
  for (let index = 0, matched = 0; index < source.symbols.length;) {
    if (source.symbols[index] === candidateSymbols[matched]) {
      index += 1;
      matched += 1;
    }
    if (matched === candidateSymbols.length) {
      const start = index - matched;
      matches.push({
        start: source.ranges[start]!.start,
        end: source.ranges[start + candidateSymbols.length - 1]!.end,
      });
      matched = prefix[matched - 1]!;
    } else if (index < source.symbols.length && source.symbols[index] !== candidateSymbols[matched]) {
      if (matched > 0) matched = prefix[matched - 1]!;
      else index += 1;
    }
  }
  return matches;
}

function canonicalExcerpts(values: string[], source: NormalizedText, originalSource: string): string[] | null {
  const excerpts: string[] = [];
  for (const value of values) {
    const match = findSourceMatches(source, value)[0];
    if (!match) return null;
    excerpts.push(originalSource.slice(match.start, match.end));
  }
  return excerpts;
}

function normalizedStrings(value: unknown): string[] | null {
  return Array.isArray(value) && value.every(nonEmptyString) ? value : null;
}

function failure(issue: AnalysisOutputIssueCode): AnalysisOutputValidation {
  return { success: false, issues: [issue] };
}

export function parseAnalysisOutput(
  input: unknown,
  sourceResume: string,
): AnalysisOutputValidation {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, ["jobRequirements", "suggestions", "documentStructure"])
  ) {
    return failure("invalid_root");
  }

  if (!Array.isArray(input.jobRequirements) || !Array.isArray(input.suggestions)) {
    return failure("invalid_collections");
  }

  const source = normalizeWithSourceRanges(sourceResume);
  const jobRequirements: JobRequirement[] = [];
  const requirementIds = new Set<string>();

  for (const rawRequirement of input.jobRequirements) {
    if (
      !isRecord(rawRequirement) ||
      !hasExactKeys(rawRequirement, ["id", "requirement", "status", "evidence", "pointsToConfirm"]) ||
      !nonEmptyString(rawRequirement.id) ||
      !nonEmptyString(rawRequirement.requirement) ||
      !["demonstrated", "partially_demonstrated", "not_demonstrated"].includes(
        String(rawRequirement.status),
      ) ||
      !Array.isArray(rawRequirement.evidence) ||
      !rawRequirement.evidence.every(nonEmptyString) ||
      !Array.isArray(rawRequirement.pointsToConfirm) ||
      !rawRequirement.pointsToConfirm.every(nonEmptyString)
    ) {
      continue;
    }

    const status = rawRequirement.status as RequirementStatus;
    if (requirementIds.has(rawRequirement.id)) continue;

    const matchedEvidence = canonicalExcerpts(
      rawRequirement.evidence as string[],
      source,
      sourceResume,
    );
    const supportedStatus = status !== "not_demonstrated" && matchedEvidence?.length
      ? status
      : "not_demonstrated";
    const evidence = supportedStatus === "not_demonstrated" ? [] : matchedEvidence!;
    const pointsToConfirm = rawRequirement.pointsToConfirm as string[];
    const safePointsToConfirm = supportedStatus === "not_demonstrated" && pointsToConfirm.length === 0
      ? [`Confirme se você possui experiência ou qualificação relacionada a: ${rawRequirement.requirement}.`]
      : pointsToConfirm;

    requirementIds.add(rawRequirement.id);
    jobRequirements.push({
      id: rawRequirement.id,
      requirement: rawRequirement.requirement,
      status: supportedStatus,
      evidence,
      pointsToConfirm: safePointsToConfirm,
    });
  }

  const suggestions: AnalysisSuggestion[] = [];
  const suggestionIds = new Set<string>();

  for (const rawSuggestion of input.suggestions) {
    if (
      !isRecord(rawSuggestion) ||
      !hasExactKeys(rawSuggestion, [
        "id",
        "category",
        "section",
        "originalText",
        "suggestedText",
        "relatedRequirementIds",
        "rationale",
        "sourceFacts",
        "pointsToConfirm",
      ]) ||
      !nonEmptyString(rawSuggestion.id) ||
      (rawSuggestion.category !== "job_alignment" && rawSuggestion.category !== "proofreading") ||
      !nonEmptyString(rawSuggestion.section) ||
      !nonEmptyString(rawSuggestion.originalText) ||
      !nonEmptyString(rawSuggestion.suggestedText) ||
      !stringArray(rawSuggestion.relatedRequirementIds) ||
      !nonEmptyString(rawSuggestion.rationale) ||
      !stringArray(rawSuggestion.sourceFacts) ||
      !Array.isArray(rawSuggestion.pointsToConfirm) ||
      !rawSuggestion.pointsToConfirm.every(nonEmptyString)
    ) {
      continue;
    }

    if (suggestionIds.has(rawSuggestion.id)) continue;

    const originalMatches = findSourceMatches(source, rawSuggestion.originalText);
    const originalRange = originalMatches.length === 1 ? originalMatches[0] : undefined;
    const sourceFacts = canonicalExcerpts(
      rawSuggestion.sourceFacts as string[],
      source,
      sourceResume,
    );
    const relatedRequirementIds = [...new Set(rawSuggestion.relatedRequirementIds as string[])].filter(
      (id) => jobRequirements.some(
        (requirement) => requirement.id === id && requirement.status !== "not_demonstrated",
      ),
    );
    const category = rawSuggestion.category as SuggestionCategory;
    const isSupportedSuggestionType = category === "proofreading"
      ? rawSuggestion.relatedRequirementIds.length === 0 &&
        rawSuggestion.sourceFacts.length === 0 &&
        rawSuggestion.pointsToConfirm.length === 0
      : Boolean(sourceFacts?.length) && relatedRequirementIds.length > 0;

    if (
      !originalRange ||
      rawSuggestion.suggestedText.trim() === sourceResume.slice(originalRange.start, originalRange.end).trim() ||
      !sourceFacts ||
      !isSupportedSuggestionType
    ) continue;

    suggestionIds.add(rawSuggestion.id);
    suggestions.push({
      id: rawSuggestion.id,
      category,
      section: rawSuggestion.section,
      originalText: sourceResume.slice(originalRange.start, originalRange.end),
      suggestedText: rawSuggestion.suggestedText,
      relatedRequirementIds,
      rationale: rawSuggestion.rationale,
      sourceFacts,
      pointsToConfirm: rawSuggestion.pointsToConfirm as string[],
      sourceRange: originalRange,
    });
  }

  const nonOverlappingSuggestions: AnalysisSuggestion[] = [];
  const acceptedRanges: SourceRange[] = [];
  for (const suggestion of [...suggestions].sort((left, right) => left.sourceRange.start - right.sourceRange.start)) {
    const overlaps = acceptedRanges.some(
      (range) => suggestion.sourceRange.start < range.end && range.start < suggestion.sourceRange.end,
    );
    if (overlaps) {
      suggestionIds.delete(suggestion.id);
      continue;
    }
    acceptedRanges.push(suggestion.sourceRange);
    nonOverlappingSuggestions.push(suggestion);
  }

  const rawStructure = isRecord(input.documentStructure) ? input.documentStructure : {};
  const requestedSuggestionOrder = normalizedStrings(rawStructure.suggestionOrder) ?? [];
  const orderedSuggestionIds = [...new Set(requestedSuggestionOrder.filter((id) => suggestionIds.has(id)))];
  for (const suggestion of nonOverlappingSuggestions) {
    if (!orderedSuggestionIds.includes(suggestion.id)) orderedSuggestionIds.push(suggestion.id);
  }

  const usedSections = new Set(nonOverlappingSuggestions.map((suggestion) => suggestion.section));
  const requestedSections = normalizedStrings(rawStructure.sectionOrder) ?? [];
  const orderedSections = [...new Set(requestedSections.filter((section) => usedSections.has(section)))];
  for (const suggestion of nonOverlappingSuggestions) {
    if (!orderedSections.includes(suggestion.section)) orderedSections.push(suggestion.section);
  }

  return {
    success: true,
    data: {
      jobRequirements,
      suggestions: nonOverlappingSuggestions,
      documentStructure: {
        sectionOrder: orderedSections,
        suggestionOrder: orderedSuggestionIds,
      },
    },
  };
}
