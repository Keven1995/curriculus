import { PixPaymentProviderError } from "./payment-errors.js";
import type {
  CreatePixPaymentInput,
  PixPaymentCharge,
  PixPaymentProvider,
} from "./pix-payment-provider.js";
import type { PaymentStatusProvider, ProviderPaymentDetails } from "./payment-status-provider.js";
import type {
  PendingPaymentCancellationProvider,
  PendingPaymentCancellationStatus,
} from "./pending-payment-cancellation-provider.js";

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

function parsePaymentDetails(value: unknown, requestedPaymentId: string): ProviderPaymentDetails {
  if (!isRecord(value)) throw new PixPaymentProviderError();

  const rawId = value.id;
  const paymentId = typeof rawId === "string" || typeof rawId === "number" ? String(rawId) : "";
  const status = value.status;
  const transactionAmount = value.transaction_amount;
  const currency = value.currency_id;
  const externalReference = value.external_reference;
  const paymentMethodId = value.payment_method_id;
  const rawDateApproved = value.date_approved;
  let dateApproved: Date | null = null;

  if (rawDateApproved !== undefined && rawDateApproved !== null) {
    if (typeof rawDateApproved !== "string") throw new PixPaymentProviderError();
    dateApproved = new Date(rawDateApproved);
    if (Number.isNaN(dateApproved.getTime())) throw new PixPaymentProviderError();
  }

  if (
    !paymentId ||
    paymentId !== requestedPaymentId ||
    typeof status !== "string" ||
    !status ||
    typeof transactionAmount !== "number" ||
    !Number.isFinite(transactionAmount) ||
    typeof currency !== "string" ||
    (externalReference !== null && typeof externalReference !== "string") ||
    (paymentMethodId !== null && typeof paymentMethodId !== "string")
  ) {
    throw new PixPaymentProviderError();
  }

  return {
    paymentId,
    status,
    transactionAmount,
    currency,
    externalReference: typeof externalReference === "string" ? externalReference : null,
    paymentMethodId: typeof paymentMethodId === "string" ? paymentMethodId : null,
    dateApproved,
  };
}

export class MercadoPagoPixPaymentProvider implements
  PixPaymentProvider,
  PaymentStatusProvider,
  PendingPaymentCancellationProvider
{
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

  async getPaymentDetails(paymentId: string): Promise<ProviderPaymentDetails> {
    let response: Response;
    try {
      response = await this.fetcher(
        `https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`,
        {
          method: "GET",
          headers: { authorization: `Bearer ${this.accessToken}` },
          signal: AbortSignal.timeout(15_000),
        },
      );
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
    return parsePaymentDetails(responseBody, paymentId);
  }

  async cancelPendingPayment(
    paymentId: string,
    expectedOrderId: string,
  ): Promise<PendingPaymentCancellationStatus> {
    const before = await this.getPaymentDetails(paymentId);
    this.assertCancellationPaymentMatch(before, paymentId, expectedOrderId);
    const beforeStatus = this.cancellationStatus(before.status);
    if (beforeStatus !== "pending") return beforeStatus;

    try {
      await this.fetcher(
        `https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`,
        {
          method: "PUT",
          headers: {
            authorization: `Bearer ${this.accessToken}`,
            "content-type": "application/json",
          },
          signal: AbortSignal.timeout(15_000),
          body: JSON.stringify({ status: "cancelled" }),
        },
      );
    } catch {
      // A follow-up authoritative read handles timeouts after a successful cancellation.
    }

    const after = await this.getPaymentDetails(paymentId);
    this.assertCancellationPaymentMatch(after, paymentId, expectedOrderId);
    const afterStatus = this.cancellationStatus(after.status);
    if (afterStatus === "pending") throw new PixPaymentProviderError();
    return afterStatus;
  }

  private assertCancellationPaymentMatch(
    payment: ProviderPaymentDetails,
    expectedPaymentId: string,
    expectedOrderId: string,
  ): void {
    if (
      payment.paymentId !== expectedPaymentId ||
      payment.externalReference !== expectedOrderId ||
      payment.transactionAmount !== 1.99 ||
      payment.currency !== "BRL" ||
      payment.paymentMethodId !== "pix"
    ) {
      throw new PixPaymentProviderError();
    }
  }

  private cancellationStatus(status: string): "pending" | PendingPaymentCancellationStatus {
    switch (status) {
      case "pending":
      case "in_process":
      case "authorized":
      case "in_mediation":
        return "pending";
      case "cancelled":
        return "cancelled";
      case "approved":
        return "approved";
      case "rejected":
        return "rejected";
      case "expired":
        return "expired";
      case "refunded":
      case "charged_back":
        return "refunded";
      default:
        throw new PixPaymentProviderError();
    }
  }
}
