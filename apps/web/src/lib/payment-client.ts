export type PixPaymentApiResponse = {
  orderId: string;
  amountCents: 199;
  currency: "BRL";
  status: "pending";
  expiresAt: string;
  qrCode: string;
  qrCodeBase64: string;
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

  const baseUrl = (options.apiBaseUrl ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000")
    .replace(/\/+$/, "");
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

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }

  if (!response.ok) {
    const code = apiErrorCode(payload) ?? "PAYMENT_FAILED";
    throw new PaymentClientError(
      paymentErrorMessages[code] ?? paymentErrorMessages.PAYMENT_FAILED,
      code,
    );
  }
  if (!isPaymentResponse(payload)) {
    throw new PaymentClientError(paymentErrorMessages.INVALID_RESPONSE, "INVALID_RESPONSE");
  }

  return payload;
}
