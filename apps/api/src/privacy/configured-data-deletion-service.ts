import type { SessionRepository } from "../persistence/session-repository.js";
import { createConfiguredPrivateDocumentStorage } from "../documents/configured-private-document-storage.js";
import { DataDeletionService } from "./data-deletion-service.js";
import { MercadoPagoPixPaymentProvider } from "../payments/mercadopago-pix-provider.js";
import { isStrongSecret } from "../security/server-configuration.js";

export function createConfiguredDataDeletionService(
  repository: SessionRepository,
  environment: NodeJS.ProcessEnv = process.env,
): DataDeletionService {
  const accessToken = environment.MERCADOPAGO_ACCESS_TOKEN?.trim();
  return new DataDeletionService(
    repository,
    createConfiguredPrivateDocumentStorage(environment) ?? null,
    isStrongSecret(accessToken)
      ? new MercadoPagoPixPaymentProvider(accessToken)
      : null,
  );
}
