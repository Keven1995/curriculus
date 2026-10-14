export type PixPaymentApiResponse = {
  orderId: string;
  amountCents: 199;
  currency: "BRL";
  status: "pending";
  expiresAt: string;
  qrCode: string;
  qrCodeBase64: string;
};

export type PixPaymentStatus = "pending" | "approved" | "rejected" | "expired" | "refunded";

export type FinalDocumentApiResponse = {
  format: "pdf";
  downloadPath: string;
  expiresAt: string;
};

type PaymentRequestOptions = {
  apiBaseUrl?: string;
  fetcher?: typeof fetch;
};

export class PaymentClientError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "PaymentClientError";
  }
}

const paymentErrorMessages: Record<string, string> = {
  INVALID_REQUEST: "Informe um e-mail válido para gerar o Pix.",
  PAYMENT_NOT_CONFIGURED: "O pagamento Pix ainda não está habilitado neste ambiente.",
  PERSISTENCE_UNAVAILABLE: "O serviço está temporariamente indisponível. Tente novamente mais tarde.",
  SESSION_NOT_PAYABLE: "Esta análise expirou ou não está mais disponível. Gere uma nova análise.",
  ORDER_NOT_PENDING: "Este pedido não aceita uma nova cobrança.",
  CHECKOUT_WINDOW_TOO_SHORT: "A análise está próxima do vencimento. Gere uma nova análise para continuar.",
  PROVIDER_UNAVAILABLE: "Não foi possível gerar o Pix. Tente novamente mais tarde.",
  PAYMENT_FAILED: "Não foi possível gerar o Pix. Tente novamente mais tarde.",
  NETWORK_ERROR: "Não foi possível conectar ao serviço. Verifique sua conexão e tente novamente.",
  INVALID_RESPONSE: "O serviço retornou uma resposta inválida. Tente novamente mais tarde.",
  LOCAL_TEST_DOCUMENT_FAILED: "Não foi possível gerar o PDF de teste local. Tente novamente.",
  PAYMENT_NOT_FOUND: "Não foi possível localizar a cobrança desta análise.",
  PAYMENT_NOT_APPROVED: "A cobrança ainda não foi aprovada.",
  PERSISTENCE_NOT_CONFIGURED: "O armazenamento ainda não está configurado neste ambiente.",
  DOCUMENT_NOT_CONFIGURED: "A geração do currículo ainda não está habilitada neste ambiente.",
  INVALID_DOCUMENT_REQUEST: "Não foi possível validar as sugestões aprovadas.",
  INVALID_APPROVED_SUGGESTIONS: "As sugestões aprovadas não correspondem a esta análise.",
  SESSION_NOT_AVAILABLE: "A análise expirou ou não está mais disponível.",
  DOCUMENT_STORAGE_UNAVAILABLE: "O documento não pôde ser armazenado. Tente novamente mais tarde.",
  DOCUMENT_RENDER_FAILED: "Não foi possível montar o PDF. Tente novamente mais tarde.",
  DOCUMENT_GENERATION_FAILED: "Não foi possível gerar o currículo. Tente novamente mais tarde.",
  LAYOUT_IMPORT_NOT_AVAILABLE: "O layout de referência não está disponível nesta sessão. Gere uma nova análise local.",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPaymentResponse(value: unknown): value is PixPaymentApiResponse {
  if (!isRecord(value)) return false;
  return (
    typeof value.orderId === "string" && value.orderId.length > 0 &&
    value.amountCents === 199 &&
    value.currency === "BRL" &&
    value.status === "pending" &&
    typeof value.expiresAt === "string" && !Number.isNaN(Date.parse(value.expiresAt)) &&
    typeof value.qrCode === "string" && value.qrCode.length > 0 && value.qrCode.length <= 2_048 &&
    typeof value.qrCodeBase64 === "string" && value.qrCodeBase64.length > 0 && value.qrCodeBase64.length <= 256_000
  );
}

function apiErrorCode(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.error)) return undefined;
  return typeof value.error.code === "string" ? value.error.code : undefined;
}

function baseApiUrl(options: PaymentRequestOptions): string {
  return (options.apiBaseUrl ?? process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:4000")
    .replace(/\/+$/, "");
}

async function readApiResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function throwApiError(payload: unknown): never {
  const code = apiErrorCode(payload) ?? "PAYMENT_FAILED";
  throw new PaymentClientError(
    paymentErrorMessages[code] ?? paymentErrorMessages.PAYMENT_FAILED,
    code,
  );
}

export async function createPixPayment(
  sessionId: string,
  payerEmail: string,
  options: PaymentRequestOptions = {},
): Promise<PixPaymentApiResponse> {
  const normalizedEmail = payerEmail.trim();
  if (
    !normalizedEmail ||
    Array.from(normalizedEmail).length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)
  ) {
    throw new PaymentClientError("Informe um e-mail válido para gerar o Pix.", "INVALID_EMAIL");
  }
  if (!sessionId.trim()) {
    throw new PaymentClientError("A análise não está mais disponível. Gere uma nova análise.", "INVALID_SESSION");
  }

  const baseUrl = baseApiUrl(options);
  const fetcher = options.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher(
      `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/payments/pix`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payerEmail: normalizedEmail }),
      },
    );
  } catch {
    throw new PaymentClientError(paymentErrorMessages.NETWORK_ERROR, "NETWORK_ERROR");
  }

  const payload = await readApiResponse(response);

  if (!response.ok) throwApiError(payload);
  if (!isPaymentResponse(payload)) {
    throw new PaymentClientError(paymentErrorMessages.INVALID_RESPONSE, "INVALID_RESPONSE");
  }

  return payload;
}

export async function getPixPaymentStatus(
  sessionId: string,
  options: PaymentRequestOptions = {},
): Promise<PixPaymentStatus> {
  if (!sessionId.trim()) throw new PaymentClientError(paymentErrorMessages.INVALID_RESPONSE, "INVALID_SESSION");
  const fetcher = options.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher(
      `${baseApiUrl(options)}/sessions/${encodeURIComponent(sessionId)}/payments/status`,
      { method: "GET" },
    );
  } catch {
    throw new PaymentClientError(paymentErrorMessages.NETWORK_ERROR, "NETWORK_ERROR");
  }

  const payload = await readApiResponse(response);
  if (!response.ok) throwApiError(payload);
  if (
    !isRecord(payload) ||
    !["pending", "approved", "rejected", "expired", "refunded"].includes(String(payload.status))
  ) {
    throw new PaymentClientError(paymentErrorMessages.INVALID_RESPONSE, "INVALID_RESPONSE");
  }
  return payload.status as PixPaymentStatus;
}

async function requestFinalDocument(
  sessionId: string,
  approvedSuggestionIds: readonly string[],
  path: string,
  options: PaymentRequestOptions = {},
): Promise<FinalDocumentApiResponse> {
  if (
    !sessionId.trim() ||
    approvedSuggestionIds.length > 100 ||
    approvedSuggestionIds.some((id) => typeof id !== "string" || !id.trim()) ||
    new Set(approvedSuggestionIds).size !== approvedSuggestionIds.length
  ) {
    throw new PaymentClientError(paymentErrorMessages.INVALID_RESPONSE, "INVALID_DOCUMENT_REQUEST");
  }

  const fetcher = options.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher(
      `${baseApiUrl(options)}${path}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approvedSuggestionIds }),
      },
    );
  } catch {
    throw new PaymentClientError(paymentErrorMessages.NETWORK_ERROR, "NETWORK_ERROR");
  }

  const payload = await readApiResponse(response);
  if (!response.ok) throwApiError(payload);
  const expectedPrefix = `/documents/${encodeURIComponent(sessionId)}?token=`;
  if (
    !isRecord(payload) ||
    payload.format !== "pdf" ||
    typeof payload.downloadPath !== "string" ||
    !payload.downloadPath.startsWith(expectedPrefix) ||
    payload.downloadPath.length > 2_048 ||
    payload.downloadPath.length === expectedPrefix.length ||
    typeof payload.expiresAt !== "string" ||
    Number.isNaN(Date.parse(payload.expiresAt))
  ) {
    throw new PaymentClientError(paymentErrorMessages.INVALID_RESPONSE, "INVALID_RESPONSE");
  }
  return payload as FinalDocumentApiResponse;
}

export function createFinalDocument(
  sessionId: string,
  approvedSuggestionIds: readonly string[],
  options: PaymentRequestOptions = {},
): Promise<FinalDocumentApiResponse> {
  return requestFinalDocument(
    sessionId,
    approvedSuggestionIds,
    `/sessions/${encodeURIComponent(sessionId)}/documents`,
    options,
  );
}

export function createLocalTestDocument(
  sessionId: string,
  approvedSuggestionIds: readonly string[],
  options: PaymentRequestOptions = {},
): Promise<FinalDocumentApiResponse> {
  return requestFinalDocument(
    sessionId,
    approvedSuggestionIds,
    `/__local-test/sessions/${encodeURIComponent(sessionId)}/documents`,
    options,
  );
}
