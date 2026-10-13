import type { OrderRecord, SessionRepository } from "../persistence/session-repository.js";
import type { PixPaymentCharge, PixPaymentProvider } from "./pix-payment-provider.js";
import { PixPaymentError } from "./payment-errors.js";

const FIXED_PRICE_CENTS = 199 as const;
const MIN_CHECKOUT_WINDOW_MS = 30 * 60 * 1_000;

export type PixPaymentResponse = {
  orderId: string;
  amountCents: 199;
  currency: "BRL";
  status: "pending";
  expiresAt: Date;
  qrCode: string;
  qrCodeBase64: string;
};

export interface PixPaymentRepository extends Pick<SessionRepository, "isReady" | "createPendingOrder" | "savePixPayment"> {}

export interface PixPaymentServiceContract {
  createPixPayment(sessionId: string, payerEmail: string): Promise<PixPaymentResponse>;
}

function responseFromStoredOrder(order: OrderRecord): PixPaymentResponse | undefined {
  if (!order.providerPaymentId || !order.pixQrCode || !order.pixQrCodeBase64) return undefined;
  return {
    orderId: order.id,
    amountCents: FIXED_PRICE_CENTS,
    currency: "BRL",
    status: "pending",
    expiresAt: order.checkoutExpiresAt,
    qrCode: order.pixQrCode,
    qrCodeBase64: order.pixQrCodeBase64,
  };
}

export class PixPaymentService implements PixPaymentServiceContract {
  constructor(
    private readonly repository: PixPaymentRepository,
    private readonly provider: PixPaymentProvider,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async createPixPayment(sessionId: string, payerEmail: string): Promise<PixPaymentResponse> {
    let isReady: boolean;
    try {
      isReady = await this.repository.isReady();
    } catch {
      isReady = false;
    }
    if (!isReady) throw new PixPaymentError("PERSISTENCE_UNAVAILABLE");

    let order: OrderRecord | null;
    try {
      order = await this.repository.createPendingOrder(sessionId);
    } catch {
      throw new PixPaymentError("PERSISTENCE_UNAVAILABLE");
    }

    if (!order || order.sessionId !== sessionId) {
      throw new PixPaymentError("SESSION_NOT_PAYABLE");
    }
    if (order.status !== "pending") throw new PixPaymentError("ORDER_NOT_PENDING");

    const now = this.now().getTime();
    const expiresAt = order.checkoutExpiresAt.getTime();
    if (expiresAt <= now) {
      throw new PixPaymentError("CHECKOUT_WINDOW_TOO_SHORT");
    }

    const storedResponse = responseFromStoredOrder(order);
    if (storedResponse) return storedResponse;
    if (expiresAt - now < MIN_CHECKOUT_WINDOW_MS) {
      throw new PixPaymentError("CHECKOUT_WINDOW_TOO_SHORT");
    }

    let charge: PixPaymentCharge;
    try {
      charge = await this.provider.createPixPayment({
        orderId: order.id,
        amountCents: FIXED_PRICE_CENTS,
        currency: "BRL",
        payerEmail,
        idempotencyKey: order.id,
        expiresAt: order.checkoutExpiresAt,
      });
    } catch {
      throw new PixPaymentError("PROVIDER_UNAVAILABLE");
    }

    let saved: boolean;
    try {
      saved = await this.repository.savePixPayment(order.id, charge);
    } catch {
      throw new PixPaymentError("PERSISTENCE_UNAVAILABLE");
    }
    if (!saved) throw new PixPaymentError("PERSISTENCE_UNAVAILABLE");

    return {
      orderId: order.id,
      amountCents: FIXED_PRICE_CENTS,
      currency: "BRL",
      status: "pending",
      expiresAt: order.checkoutExpiresAt,
      qrCode: charge.qrCode,
      qrCodeBase64: charge.qrCodeBase64,
    };
  }
}
