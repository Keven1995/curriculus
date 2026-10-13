export type PendingPaymentCancellationStatus =
  | "cancelled"
  | "approved"
  | "rejected"
  | "expired"
  | "refunded";

export interface PendingPaymentCancellationProvider {
  cancelPendingPayment(
    paymentId: string,
    expectedOrderId: string,
  ): Promise<PendingPaymentCancellationStatus>;
}
