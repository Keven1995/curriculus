export type PixPaymentErrorCode =
  | "PERSISTENCE_UNAVAILABLE"
  | "SESSION_NOT_PAYABLE"
  | "ORDER_NOT_PENDING"
  | "CHECKOUT_WINDOW_TOO_SHORT"
  | "PROVIDER_UNAVAILABLE";

export class PixPaymentError extends Error {
  constructor(readonly code: PixPaymentErrorCode) {
    super(code);
    this.name = "PixPaymentError";
  }
}

export class PixPaymentProviderError extends Error {
  constructor() {
    super("Pix payment provider request failed.");
    this.name = "PixPaymentProviderError";
  }
}
