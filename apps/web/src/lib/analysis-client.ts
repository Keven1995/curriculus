import { validateIntake, type IntakeInput } from "./intake";
import { fetchWithTimeout, RequestTimeoutError } from "./fetch-with-timeout";

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
  category: "job_alignment" | "proofreading";
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
  documentStructure: { sectionOrder: string[]; suggestionOrder: string[] };
};

export type AnalysisApiResponse = {
  sessionId: string;
  expiresAt: string;
  localTestMode?: boolean;
  usesReferenceLayout?: boolean;
  analysis: AnalysisOutput;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    estimatedCostUsd: number | null;
  };
};

export type SuggestionDecision = "approved" | "rejected";
export type SuggestionDecisions = Record<string, SuggestionDecision>;

export class AnalysisClientError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "AnalysisClientError";
  }
}

type RequestOptions = {
  apiBaseUrl?: string;
  fetcher?: typeof fetch;
  resumeLayoutTemplateId?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isRequirement(value: unknown): value is JobRequirement {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.requirement === "string" &&
    (value.status === "demonstrated" ||
      value.status === "partially_demonstrated" ||
      value.status === "not_demonstrated") &&
    isStringArray(value.evidence) &&
    isStringArray(value.pointsToConfirm)
  );
}

function isSuggestion(value: unknown): value is AnalysisSuggestion {
  if (!isRecord(value) || !isRecord(value.sourceRange)) return false;
  return (
    typeof value.id === "string" &&
    (value.category === "job_alignment" || value.category === "proofreading") &&
    typeof value.section === "string" &&
    typeof value.originalText === "string" &&
    typeof value.suggestedText === "string" &&
    isStringArray(value.relatedRequirementIds) &&
    typeof value.rationale === "string" &&
    isStringArray(value.sourceFacts) &&
    isStringArray(value.pointsToConfirm) &&
    Number.isInteger(value.sourceRange.start) &&
    Number.isInteger(value.sourceRange.end)
  );
}

function isAnalysisOutput(value: unknown): value is AnalysisOutput {
  if (!isRecord(value) || !isRecord(value.documentStructure)) return false;
  return (
    Array.isArray(value.jobRequirements) && value.jobRequirements.every(isRequirement) &&
    Array.isArray(value.suggestions) && value.suggestions.every(isSuggestion) &&
    isStringArray(value.documentStructure.sectionOrder) &&
    isStringArray(value.documentStructure.suggestionOrder)
  );
}

export function isAnalysisApiResponse(value: unknown): value is AnalysisApiResponse {
  if (!isRecord(value) || !isRecord(value.usage)) return false;
  const usage = value.usage;
  return (
    typeof value.sessionId === "string" && value.sessionId.length > 0 &&
    typeof value.expiresAt === "string" && !Number.isNaN(Date.parse(value.expiresAt)) &&
    (value.localTestMode === undefined || typeof value.localTestMode === "boolean") &&
    (value.usesReferenceLayout === undefined || typeof value.usesReferenceLayout === "boolean") &&
    isAnalysisOutput(value.analysis) &&
    Number.isInteger(usage.inputTokens) &&
    Number.isInteger(usage.outputTokens) &&
    Number.isInteger(usage.totalTokens) &&
    (usage.estimatedCostUsd === null ||
      (typeof usage.estimatedCostUsd === "number" && Number.isFinite(usage.estimatedCostUsd)))
  );
}

const errorMessages: Record<string, string> = {
  INVALID_REQUEST: "Revise os campos e tente novamente.",
  JOB_DESCRIPTION_REQUIRED: "Cole a descrição completa da vaga para continuar.",
  ANALYSIS_NOT_CONFIGURED: "A análise ainda não está disponível neste ambiente.",
  PERSISTENCE_NOT_CONFIGURED: "O serviço está temporariamente indisponível. Tente novamente mais tarde.",
  PERSISTENCE_UNAVAILABLE: "O serviço está temporariamente indisponível. Tente novamente mais tarde.",
  INPUT_TOKEN_LIMIT_EXCEEDED: "O conteúdo excede o limite para uma análise. Reduza os textos e tente novamente.",
  PAYLOAD_TOO_LARGE: "Os textos excedem o tamanho permitido. Reduza o conteúdo e tente novamente.",
  ANALYSIS_PROVIDER_ERROR: "Não foi possível concluir a análise. Tente novamente mais tarde.",
  INVALID_ANALYSIS_OUTPUT: "Não foi possível validar as sugestões. Nenhuma alteração foi aplicada.",
  ANALYSIS_USAGE_LIMIT_EXCEEDED: "A análise excedeu o limite permitido. Tente novamente mais tarde.",
  ANALYSIS_FAILED: "Não foi possível concluir a análise. Tente novamente mais tarde.",
  NETWORK_ERROR: "Não foi possível conectar ao serviço. Verifique sua conexão e tente novamente.",
  INVALID_RESPONSE: "O serviço retornou uma resposta inválida. Tente novamente mais tarde.",
  PROCESSING_TIMEOUT: "A análise está demorando mais que o esperado. Tente novamente; o currículo enviado continua disponível nesta sessão.",
  LAYOUT_IMPORT_NOT_AVAILABLE: "O estilo visual não está disponível. Você pode continuar sem reenviar o PDF.",
  TEMPLATE_EXPIRED: "O estilo visual expirou. Você pode continuar sem reenviar o PDF.",
};

function apiErrorCode(payload: unknown): string | undefined {
  if (!isRecord(payload) || !isRecord(payload.error)) return undefined;
  return typeof payload.error.code === "string" ? payload.error.code : undefined;
}

export async function requestAnalysis(
  input: IntakeInput,
  options: RequestOptions = {},
): Promise<AnalysisApiResponse> {
  const validationErrors = validateIntake(input);
  if (Object.keys(validationErrors).length > 0) {
    throw new AnalysisClientError("Revise os campos indicados antes de continuar.", "INVALID_FORM");
  }

  const baseUrl = (options.apiBaseUrl ?? process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:4000")
    .replace(/\/+$/, "");
  const fetcher = options.fetcher ?? fetch;
  let response: Response;

  try {
    response = await fetchWithTimeout(fetcher, `${baseUrl}/analyses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...(input.jobDescription.trim() ? { jobDescription: input.jobDescription.trim() } : {}),
          resume: input.resume.trim(),
          dataNoticeAcknowledged: input.acknowledged,
          ...(options.resumeLayoutTemplateId ? { resumeLayoutTemplateId: options.resumeLayoutTemplateId } : {}),
      }),
    }, 75_000);
  } catch (error) {
    if (error instanceof RequestTimeoutError) {
      throw new AnalysisClientError(errorMessages.PROCESSING_TIMEOUT, "PROCESSING_TIMEOUT");
    }
    throw new AnalysisClientError(errorMessages.NETWORK_ERROR, "NETWORK_ERROR");
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }

  if (!response.ok) {
    const code = apiErrorCode(payload) ?? "ANALYSIS_FAILED";
    throw new AnalysisClientError(
      errorMessages[code] ?? errorMessages.ANALYSIS_FAILED,
      code,
    );
  }

  if (!isAnalysisApiResponse(payload)) {
    throw new AnalysisClientError(errorMessages.INVALID_RESPONSE, "INVALID_RESPONSE");
  }

  return payload;
}

export function updateSuggestionDecision(
  decisions: SuggestionDecisions,
  id: string,
  decision: SuggestionDecision,
): SuggestionDecisions {
  return { ...decisions, [id]: decision };
}

export function summarizeDecisions(
  suggestions: AnalysisSuggestion[],
  decisions: SuggestionDecisions,
): { approved: number; rejected: number; pending: number } {
  return suggestions.reduce(
    (summary, suggestion) => {
      const decision = decisions[suggestion.id];
      if (decision === "approved") summary.approved += 1;
      else if (decision === "rejected") summary.rejected += 1;
      else summary.pending += 1;
      return summary;
    },
    { approved: 0, rejected: 0, pending: 0 },
  );
}

export function approvedSuggestionIds(
  analysis: AnalysisOutput,
  decisions: SuggestionDecisions,
): string[] {
  const order = new Map(
    analysis.documentStructure.suggestionOrder.map((id, index) => [id, index]),
  );
  return analysis.suggestions
    .filter((suggestion) => decisions[suggestion.id] === "approved")
    .sort((left, right) =>
      (order.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
      (order.get(right.id) ?? Number.MAX_SAFE_INTEGER),
    )
    .map(({ id }) => id);
}

/** Applies only approved, exact-source, non-overlapping suggestions. */
export function buildResumeWithApprovedSuggestions(
  resume: string,
  analysis: AnalysisOutput,
  decisions: SuggestionDecisions,
): string {
  const approved = analysis.suggestions
    .filter((suggestion) => decisions[suggestion.id] === "approved")
    .sort((left, right) => left.sourceRange.start - right.sourceRange.start);

  let result = "";
  let cursor = 0;
  for (const suggestion of approved) {
    const { start, end } = suggestion.sourceRange;
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < cursor ||
      end <= start ||
      end > resume.length ||
      resume.slice(start, end) !== suggestion.originalText
    ) continue;

    result += resume.slice(cursor, start) + suggestion.suggestedText;
    cursor = end;
  }
  return result + resume.slice(cursor);
}
