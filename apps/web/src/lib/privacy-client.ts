type PrivacyRequestOptions = {
  apiBaseUrl?: string;
  fetcher?: typeof fetch;
};

export class PrivacyRequestError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "PrivacyRequestError";
  }
}

const errorMessages: Record<string, string> = {
  INVALID_SESSION: "A sessão que você quer excluir não é válida.",
  PERSISTENCE_UNAVAILABLE: "O armazenamento está indisponível. Seus dados não foram confirmados como excluídos; tente novamente.",
  DOCUMENT_STORAGE_UNAVAILABLE: "O PDF não pôde ser removido. Seus dados não foram confirmados como excluídos; tente novamente.",
  PAYMENT_CANCELLATION_UNAVAILABLE: "Não foi possível cancelar a cobrança Pix. Seus dados não foram excluídos; tente novamente.",
  SESSION_DELETION_CONFLICT: "A sessão mudou durante a exclusão. Tente novamente.",
  DATA_DELETION_NOT_CONFIGURED: "A exclusão não está disponível neste ambiente.",
  DATA_DELETION_FAILED: "Não foi possível concluir a exclusão. Tente novamente.",
};

export async function deleteSessionData(
  sessionId: string,
  options: PrivacyRequestOptions = {},
): Promise<void> {
  if (!sessionId.trim()) throw new PrivacyRequestError(errorMessages.INVALID_SESSION!, "INVALID_SESSION");

  const baseUrl = (options.apiBaseUrl ?? process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:4000")
    .replace(/\/+$/, "");
  const fetcher = options.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher(`${baseUrl}/sessions/${encodeURIComponent(sessionId)}/data`, {
      method: "DELETE",
    });
  } catch {
    throw new PrivacyRequestError("Não foi possível conectar ao serviço. Tente novamente.", "NETWORK_ERROR");
  }

  if (response.status === 204) return;
  let code = "DATA_DELETION_FAILED";
  try {
    const payload: unknown = await response.json();
    if (
      typeof payload === "object" && payload !== null &&
      "error" in payload && typeof payload.error === "object" && payload.error !== null &&
      "code" in payload.error && typeof payload.error.code === "string"
    ) {
      code = payload.error.code;
    }
  } catch {
    // Keep a generic failure when the server does not return a structured error.
  }
  throw new PrivacyRequestError(
    errorMessages[code] ?? errorMessages.DATA_DELETION_FAILED!,
    code,
  );
}
