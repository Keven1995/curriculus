import type { SessionRepository } from "../persistence/session-repository.js";
import { MercadoPagoPixPaymentProvider } from "./mercadopago-pix-provider.js";
import { PixPaymentService } from "./pix-payment-service.js";

export function createConfiguredPixPaymentService(
  repository: SessionRepository,
  environment: NodeJS.ProcessEnv = process.env,
) {
  if (environment.MERCADOPAGO_PIX_ENABLED !== "true") return undefined;

  const accessToken = environment.MERCADOPAGO_ACCESS_TOKEN?.trim();
  if (!accessToken) return undefined;

  return new PixPaymentService(repository, new MercadoPagoPixPaymentProvider(accessToken));
}
