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

export type AnalysisSuggestion = {
  id: string;
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
  | { success: false; issues: string[] };

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

function exactExcerpts(values: string[], source: string): boolean {
  return values.every((value) => source.includes(value));
}

function failure(issue: string): AnalysisOutputValidation {
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

  const rawStructure = input.documentStructure;
  if (
    !isRecord(rawStructure) ||
    !hasExactKeys(rawStructure, ["sectionOrder", "suggestionOrder"]) ||
    !stringArray(rawStructure.sectionOrder) ||
    !stringArray(rawStructure.suggestionOrder)
  ) {
    return failure("invalid_document_structure");
  }

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
      return failure("invalid_requirement");
    }

    const status = rawRequirement.status as RequirementStatus;
    const evidence = rawRequirement.evidence as string[];
    const pointsToConfirm = rawRequirement.pointsToConfirm as string[];

    if (
      requirementIds.has(rawRequirement.id) ||
      !exactExcerpts(evidence, sourceResume) ||
      (status === "not_demonstrated" && (evidence.length > 0 || pointsToConfirm.length === 0)) ||
      (status !== "not_demonstrated" && evidence.length === 0)
    ) {
      return failure("unsupported_requirement");
    }

    requirementIds.add(rawRequirement.id);
    jobRequirements.push({
      id: rawRequirement.id,
      requirement: rawRequirement.requirement,
      status,
      evidence,
      pointsToConfirm,
    });
  }

  const suggestions: AnalysisSuggestion[] = [];
  const suggestionIds = new Set<string>();
  const sourceRanges: Array<{ start: number; end: number }> = [];

  for (const rawSuggestion of input.suggestions) {
    if (
      !isRecord(rawSuggestion) ||
      !hasExactKeys(rawSuggestion, [
        "id",
        "section",
        "originalText",
        "suggestedText",
        "relatedRequirementIds",
        "rationale",
        "sourceFacts",
        "pointsToConfirm",
      ]) ||
      !nonEmptyString(rawSuggestion.id) ||
      !nonEmptyString(rawSuggestion.section) ||
      !nonEmptyString(rawSuggestion.originalText) ||
      !nonEmptyString(rawSuggestion.suggestedText) ||
      !stringArray(rawSuggestion.relatedRequirementIds) ||
      !nonEmptyString(rawSuggestion.rationale) ||
      !stringArray(rawSuggestion.sourceFacts) ||
      !Array.isArray(rawSuggestion.pointsToConfirm) ||
      !rawSuggestion.pointsToConfirm.every(nonEmptyString)
    ) {
      return failure("invalid_suggestion");
    }

    const start = sourceResume.indexOf(rawSuggestion.originalText);
    const end = start + rawSuggestion.originalText.length;
    const hasUniqueSource =
      start >= 0 && sourceResume.indexOf(rawSuggestion.originalText, start + 1) === -1;
    const relatedRequirementsAreSupported = rawSuggestion.relatedRequirementIds.every(
      (id) =>
        jobRequirements.some(
          (requirement) =>
            requirement.id === id && requirement.status !== "not_demonstrated",
        ),
    );

    if (
      suggestionIds.has(rawSuggestion.id) ||
      !hasUniqueSource ||
      rawSuggestion.suggestedText === rawSuggestion.originalText ||
      !exactExcerpts(rawSuggestion.sourceFacts, sourceResume) ||
      rawSuggestion.sourceFacts.length === 0 ||
      rawSuggestion.relatedRequirementIds.length === 0 ||
      !relatedRequirementsAreSupported
    ) {
      return failure("unsupported_suggestion");
    }

    suggestionIds.add(rawSuggestion.id);
    sourceRanges.push({ start, end });
    suggestions.push({
      id: rawSuggestion.id,
      section: rawSuggestion.section,
      originalText: rawSuggestion.originalText,
      suggestedText: rawSuggestion.suggestedText,
      relatedRequirementIds: rawSuggestion.relatedRequirementIds,
      rationale: rawSuggestion.rationale,
      sourceFacts: rawSuggestion.sourceFacts,
      pointsToConfirm: rawSuggestion.pointsToConfirm,
      sourceRange: { start, end },
    });
  }

  const orderedSuggestionIds = rawStructure.suggestionOrder as string[];
  const orderedSections = rawStructure.sectionOrder as string[];
  const hasValidStructure =
    new Set(orderedSuggestionIds).size === orderedSuggestionIds.length &&
    orderedSuggestionIds.length === suggestionIds.size &&
    orderedSuggestionIds.every((id) => suggestionIds.has(id)) &&
    new Set(orderedSections).size === orderedSections.length &&
    suggestions.every((suggestion) => orderedSections.includes(suggestion.section));

  sourceRanges.sort((left, right) => left.start - right.start);
  const rangesOverlap = sourceRanges.some(
    (range, index) => index > 0 && range.start < sourceRanges[index - 1]!.end,
  );

  if (!hasValidStructure || rangesOverlap) {
    return failure("invalid_document_structure");
  }

  return {
    success: true,
    data: {
      jobRequirements,
      suggestions,
      documentStructure: {
        sectionOrder: orderedSections,
        suggestionOrder: orderedSuggestionIds,
      },
    },
  };
}
