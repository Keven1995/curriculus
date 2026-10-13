import type { SessionRepository } from "../persistence/session-repository.js";
import { MercadoPagoPixPaymentProvider } from "./mercadopago-pix-provider.js";
import { PaymentWebhookService, type PaymentWebhookServiceContract } from "./payment-webhook-service.js";

export type PaymentWebhookEndpoint = {
  secret: string;
  service: PaymentWebhookServiceContract;
};

export function createConfiguredPaymentWebhook(
  repository: SessionRepository,
  environment: NodeJS.ProcessEnv = process.env,
): PaymentWebhookEndpoint | undefined {
  const accessToken = environment.MERCADOPAGO_ACCESS_TOKEN?.trim();
  const secret = environment.MERCADOPAGO_WEBHOOK_SECRET?.trim();
  if (!accessToken || !secret) return undefined;

  const provider = new MercadoPagoPixPaymentProvider(accessToken);
  return {
    secret,
    service: new PaymentWebhookService(repository, provider),
  };
}
