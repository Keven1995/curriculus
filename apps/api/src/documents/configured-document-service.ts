import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionRepository } from "../persistence/session-repository.js";
import { DocumentService } from "./document-service.js";
import { PrivateFileDocumentStorage } from "./private-file-document-storage.js";
import { renderResumePdf } from "./pdf-renderer.js";

function isWithinDirectory(candidate: string, directory: string): boolean {
  const pathFromDirectory = relative(directory, candidate);
  return pathFromDirectory === "" || (
    pathFromDirectory !== ".." &&
    !pathFromDirectory.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromDirectory)
  );
}

export function createConfiguredDocumentService(
  repository: SessionRepository,
  environment: NodeJS.ProcessEnv = process.env,
): DocumentService | undefined {
  const storageDirectory = environment.DOCUMENT_STORAGE_DIR?.trim();
  const accessSecret = environment.DOCUMENT_DOWNLOAD_SECRET?.trim();
  if (!storageDirectory || !accessSecret || Buffer.byteLength(accessSecret, "utf8") < 32) {
    return undefined;
  }

  const resolvedStorageDirectory = resolve(storageDirectory);
  const webPublicDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../../../web/public");
  if (isWithinDirectory(resolvedStorageDirectory, webPublicDirectory)) return undefined;

  return new DocumentService(
    repository,
    new PrivateFileDocumentStorage(resolvedStorageDirectory),
    accessSecret,
    renderResumePdf,
  );
}
