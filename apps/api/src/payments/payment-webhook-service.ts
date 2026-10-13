import type { OrderRecord, OrderStatus, SessionRepository } from "../persistence/session-repository.js";
import type { PaymentStatusProvider, ProviderPaymentDetails } from "./payment-status-provider.js";

export type PaymentWebhookErrorCode = "PERSISTENCE_UNAVAILABLE" | "PROVIDER_UNAVAILABLE";

export class PaymentWebhookError extends Error {
  constructor(readonly code: PaymentWebhookErrorCode) {
    super(code);
    this.name = "PaymentWebhookError";
  }
}

export type PaymentWebhookOutcome = "processed" | "ignored";

export interface PaymentWebhookRepository extends Pick<
  SessionRepository,
  | "isReady"
  | "findOrderByProviderPaymentId"
  | "findOrder"
  | "attachProviderPaymentId"
  | "updateOrderStatusByProviderPaymentId"
> {}

export interface PaymentWebhookServiceContract {
  handlePaymentNotification(paymentId: string): Promise<PaymentWebhookOutcome>;
}

function orderStatusForProviderStatus(
  status: string,
  dateApproved: Date | null,
  order: OrderRecord,
): OrderStatus | undefined {
  switch (status) {
    case "pending":
    case "in_process":
    case "authorized":
    case "in_mediation":
      return "pending";
    case "approved":
      if (
        !dateApproved ||
        Number.isNaN(dateApproved.getTime()) ||
        dateApproved.getTime() > order.checkoutExpiresAt.getTime()
      ) {
        return undefined;
      }
      return "approved";
    case "rejected":
      return "rejected";
    case "cancelled":
    case "expired":
      return "expired";
    case "refunded":
    case "charged_back":
      return "refunded";
    default:
      return undefined;
  }
}

export class PaymentWebhookService implements PaymentWebhookServiceContract {
  constructor(
    private readonly repository: PaymentWebhookRepository,
    private readonly provider: PaymentStatusProvider,
  ) {}

  async handlePaymentNotification(paymentId: string): Promise<PaymentWebhookOutcome> {
    let ready: boolean;
    try {
      ready = await this.repository.isReady();
    } catch {
      ready = false;
    }
    if (!ready) throw new PaymentWebhookError("PERSISTENCE_UNAVAILABLE");

    let payment: ProviderPaymentDetails;
    try {
      payment = await this.provider.getPaymentDetails(paymentId);
    } catch {
      throw new PaymentWebhookError("PROVIDER_UNAVAILABLE");
    }
    if (payment.paymentId !== paymentId) return "ignored";

    let order: OrderRecord | null;
    try {
      order = await this.repository.findOrderByProviderPaymentId(paymentId);
    } catch {
      throw new PaymentWebhookError("PERSISTENCE_UNAVAILABLE");
    }
    if (!order && payment.externalReference) {
      try {
        order = await this.repository.findOrder(payment.externalReference);
      } catch {
        throw new PaymentWebhookError("PERSISTENCE_UNAVAILABLE");
      }
    }
    if (!order) return "ignored";

    if (
      payment.externalReference !== order.id ||
      payment.transactionAmount !== order.amountCents / 100 ||
      payment.currency !== order.currency ||
      payment.paymentMethodId !== "pix" ||
      (order.providerPaymentId !== null && order.providerPaymentId !== paymentId)
    ) {
      return "ignored";
    }

    if (order.providerPaymentId === null) {
      if (order.status !== "pending") return "ignored";
      let attached: boolean;
      try {
        attached = await this.repository.attachProviderPaymentId(order.id, paymentId);
      } catch {
        throw new PaymentWebhookError("PERSISTENCE_UNAVAILABLE");
      }
      if (!attached) {
        try {
          order = await this.repository.findOrderByProviderPaymentId(paymentId);
        } catch {
          throw new PaymentWebhookError("PERSISTENCE_UNAVAILABLE");
        }
        if (!order || order.id !== payment.externalReference) return "ignored";
      } else {
        order = { ...order, providerPaymentId: paymentId };
      }
    }

    const nextStatus = orderStatusForProviderStatus(payment.status, payment.dateApproved, order);
    if (!nextStatus) return "ignored";

    let updated: boolean;
    try {
      updated = await this.repository.updateOrderStatusByProviderPaymentId(paymentId, nextStatus);
    } catch {
      throw new PaymentWebhookError("PERSISTENCE_UNAVAILABLE");
    }
    return updated ? "processed" : "ignored";
  }
}
