export type ProviderPaymentDetails = {
  paymentId: string;
  status: string;
  transactionAmount: number;
  currency: string;
  externalReference: string | null;
  paymentMethodId: string | null;
  dateApproved: Date | null;
};

export interface PaymentStatusProvider {
  getPaymentDetails(paymentId: string): Promise<ProviderPaymentDetails>;
}
