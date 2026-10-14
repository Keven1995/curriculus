export class JobDescriptionRequiredError extends Error {
  constructor() {
    super("A descrição da vaga é necessária para realizar a análise.");
    this.name = "JobDescriptionRequiredError";
  }
}

export class AnalysisInputTokenLimitError extends Error {
  constructor(
    readonly estimatedTokens: number,
    readonly maximumTokens: number,
  ) {
    super("A entrada excede o limite de tokens configurado.");
    this.name = "AnalysisInputTokenLimitError";
  }
}

export class InvalidAnalysisOutputError extends Error {
  constructor() {
    super("A resposta estruturada da análise é inválida.");
    this.name = "InvalidAnalysisOutputError";
  }
}

export type AnalysisProviderFailureReason =
  | "authentication_failed"
  | "quota_exhausted"
  | "rate_limited"
  | "model_unavailable"
  | "permission_denied"
  | "request_rejected"
  | "provider_server_error"
  | "network_error"
  | "timeout"
  | "invalid_provider_response"
  | "unknown";

export type AnalysisProviderDiagnostics = {
  reason: AnalysisProviderFailureReason;
  httpStatus?: number;
  requestId?: string;
};

export class AnalysisProviderError extends Error {
  constructor(readonly diagnostics: AnalysisProviderDiagnostics = { reason: "unknown" }) {
    super("O provedor de análise não pôde concluir a solicitação.");
    this.name = "AnalysisProviderError";
  }
}

export class AnalysisUsageLimitError extends Error {
  constructor() {
    super("O uso reportado excedeu o limite configurado.");
    this.name = "AnalysisUsageLimitError";
  }
}
