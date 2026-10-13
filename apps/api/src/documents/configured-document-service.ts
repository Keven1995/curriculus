import type { SessionRepository } from "../persistence/session-repository.js";
import { DocumentService } from "./document-service.js";
import { createConfiguredPrivateDocumentStorage } from "./configured-private-document-storage.js";
import { renderResumePdf } from "./pdf-renderer.js";
import { isStrongSecret } from "../security/server-configuration.js";

export function createConfiguredDocumentService(
  repository: SessionRepository,
  environment: NodeJS.ProcessEnv = process.env,
): DocumentService | undefined {
  const storageDirectory = environment.DOCUMENT_STORAGE_DIR?.trim();
  const accessSecret = environment.DOCUMENT_DOWNLOAD_SECRET?.trim();
  const storage = createConfiguredPrivateDocumentStorage(environment);
  if (!storageDirectory || !storage || !isStrongSecret(accessSecret)) {
    return undefined;
  }

  return new DocumentService(
    repository,
    storage,
    accessSecret,
    renderResumePdf,
  );
}
