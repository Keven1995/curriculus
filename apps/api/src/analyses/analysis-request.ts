export const ANALYSIS_REQUEST_LIMITS = {
  jobUrl: 2_048,
  jobDescription: 60_000,
  resume: 80_000,
  bodyBytes: 640 * 1024,
} as const;

export type AnalysisRequest = {
  jobUrl?: string;
  jobDescription?: string;
  resume: string;
  resumeLayoutTemplateId?: string;
  dataNoticeAcknowledged: true;
};

export type AnalysisRequestIssue = {
  field: "request" | "jobUrl" | "jobDescription" | "job" | "resume" | "dataNoticeAcknowledged";
  code: "invalid_type" | "required" | "too_long" | "invalid_url" | "unknown_field";
};

export type AnalysisRequestValidation =
  | { success: true; data: AnalysisRequest }
  | { success: false; issues: AnalysisRequestIssue[] };

const allowedFields = new Set([
  "jobUrl",
  "jobDescription",
  "resume",
  "resumeLayoutTemplateId",
  "dataNoticeAcknowledged",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function characterCount(value: string): number {
  return Array.from(value).length;
}

function isValidJobUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

export function validateAnalysisRequest(input: unknown): AnalysisRequestValidation {
  if (!isRecord(input)) {
    return {
      success: false,
      issues: [{ field: "request", code: "invalid_type" }],
    };
  }

  const issues: AnalysisRequestIssue[] = [];

  for (const field of Object.keys(input)) {
    if (!allowedFields.has(field)) {
      issues.push({ field: "request", code: "unknown_field" });
    }
  }

  const readOptionalText = (
    field: "jobUrl" | "jobDescription",
    maxCharacters: number,
  ): string | undefined => {
    const value = input[field];
    if (value === undefined) return undefined;
    if (typeof value !== "string") {
      issues.push({ field, code: "invalid_type" });
      return undefined;
    }

    if (characterCount(value) > maxCharacters) {
      issues.push({ field, code: "too_long" });
    }

    return value.trim() || undefined;
  };

  const jobUrl = readOptionalText("jobUrl", ANALYSIS_REQUEST_LIMITS.jobUrl);
  const jobDescription = readOptionalText(
    "jobDescription",
    ANALYSIS_REQUEST_LIMITS.jobDescription,
  );

  if (!jobUrl && !jobDescription) {
    issues.push({ field: "job", code: "required" });
  }

  const resumeInput = input.resume;
  let resume: string | undefined;

  if (typeof resumeInput !== "string") {
    issues.push({ field: "resume", code: resumeInput === undefined ? "required" : "invalid_type" });
  } else {
    if (characterCount(resumeInput) > ANALYSIS_REQUEST_LIMITS.resume) {
      issues.push({ field: "resume", code: "too_long" });
    }
    resume = resumeInput.trim();
    if (!resume) issues.push({ field: "resume", code: "required" });
  }

  let resumeLayoutTemplateId: string | undefined;
  if (input.resumeLayoutTemplateId !== undefined) {
    if (
      typeof input.resumeLayoutTemplateId !== "string" ||
      input.resumeLayoutTemplateId.length > 64 ||
      !input.resumeLayoutTemplateId.trim()
    ) {
      issues.push({ field: "request", code: "invalid_type" });
    } else {
      resumeLayoutTemplateId = input.resumeLayoutTemplateId.trim();
    }
  }

  if (jobUrl && !isValidJobUrl(jobUrl)) {
    issues.push({ field: "jobUrl", code: "invalid_url" });
  }

  const acknowledgement = input.dataNoticeAcknowledged;
  if (typeof acknowledgement !== "boolean") {
    issues.push({
      field: "dataNoticeAcknowledged",
      code: acknowledgement === undefined ? "required" : "invalid_type",
    });
  } else if (!acknowledgement) {
    issues.push({ field: "dataNoticeAcknowledged", code: "required" });
  }

  if (issues.length > 0 || !resume) {
    return { success: false, issues };
  }

  return {
    success: true,
    data: {
      ...(jobUrl ? { jobUrl } : {}),
      ...(jobDescription ? { jobDescription } : {}),
      resume,
      ...(resumeLayoutTemplateId ? { resumeLayoutTemplateId } : {}),
      dataNoticeAcknowledged: true,
    },
  };
}
