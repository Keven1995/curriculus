import { PixPaymentProviderError } from "./payment-errors.js";
import type {
  CreatePixPaymentInput,
  PixPaymentCharge,
  PixPaymentProvider,
} from "./pix-payment-provider.js";

const MAX_QR_CODE_LENGTH = 2_048;
const MAX_QR_IMAGE_LENGTH = 256_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePaymentResponse(value: unknown, input: CreatePixPaymentInput): PixPaymentCharge {
  if (!isRecord(value)) throw new PixPaymentProviderError();

  const interaction = value.point_of_interaction;
  if (!isRecord(interaction) || !isRecord(interaction.transaction_data)) {
    throw new PixPaymentProviderError();
  }

  const transactionData = interaction.transaction_data;
  const paymentId = value.id;
  const providerPaymentId =
    typeof paymentId === "string" || typeof paymentId === "number" ? String(paymentId) : "";
  const qrCode = transactionData.qr_code;
  const qrCodeBase64 = transactionData.qr_code_base64;

  if (
    !providerPaymentId ||
    value.status !== "pending" ||
    value.transaction_amount !== input.amountCents / 100 ||
    value.currency_id !== input.currency ||
    value.external_reference !== input.orderId ||
    typeof qrCode !== "string" ||
    !qrCode.trim() ||
    qrCode.length > MAX_QR_CODE_LENGTH ||
    typeof qrCodeBase64 !== "string" ||
    !qrCodeBase64.trim() ||
    qrCodeBase64.length > MAX_QR_IMAGE_LENGTH
  ) {
    throw new PixPaymentProviderError();
  }

  return { providerPaymentId, qrCode, qrCodeBase64 };
}

export class MercadoPagoPixPaymentProvider implements PixPaymentProvider {
  constructor(
    private readonly accessToken: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async createPixPayment(input: CreatePixPaymentInput): Promise<PixPaymentCharge> {
    let response: Response;
    try {
      response = await this.fetcher("https://api.mercadopago.com/v1/payments", {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.accessToken}`,
          "content-type": "application/json",
          "x-idempotency-key": input.idempotencyKey,
        },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({
          transaction_amount: input.amountCents / 100,
          description: "Curriculus — geração de currículo",
          payment_method_id: "pix",
          date_of_expiration: input.expiresAt.toISOString(),
          external_reference: input.orderId,
          payer: { email: input.payerEmail },
        }),
      });
    } catch {
      throw new PixPaymentProviderError();
    }

    if (!response.ok) throw new PixPaymentProviderError();

    let responseBody: unknown;
    try {
      responseBody = await response.json();
    } catch {
      throw new PixPaymentProviderError();
    }

    return parsePaymentResponse(responseBody, input);
  }
}
