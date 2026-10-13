export type CreatePixPaymentInput = {
  orderId: string;
  amountCents: 199;
  currency: "BRL";
  payerEmail: string;
  idempotencyKey: string;
  expiresAt: Date;
};

export type PixPaymentCharge = {
  providerPaymentId: string;
  qrCode: string;
  qrCodeBase64: string;
};

export interface PixPaymentProvider {
  createPixPayment(input: CreatePixPaymentInput): Promise<PixPaymentCharge>;
}
