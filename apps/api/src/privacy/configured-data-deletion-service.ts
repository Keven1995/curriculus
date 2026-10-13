import type { SessionRepository } from "../persistence/session-repository.js";
import { createConfiguredPrivateDocumentStorage } from "../documents/configured-private-document-storage.js";
import { DataDeletionService } from "./data-deletion-service.js";
import { MercadoPagoPixPaymentProvider } from "../payments/mercadopago-pix-provider.js";

export function createConfiguredDataDeletionService(
  repository: SessionRepository,
  environment: NodeJS.ProcessEnv = process.env,
): DataDeletionService {
  return new DataDeletionService(
    repository,
    createConfiguredPrivateDocumentStorage(environment) ?? null,
    environment.MERCADOPAGO_ACCESS_TOKEN?.trim()
      ? new MercadoPagoPixPaymentProvider(environment.MERCADOPAGO_ACCESS_TOKEN.trim())
      : null,
  );
}
