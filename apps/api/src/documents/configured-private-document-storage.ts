import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { PrivateFileDocumentStorage } from "./private-file-document-storage.js";

function isWithinDirectory(candidate: string, directory: string): boolean {
  const pathFromDirectory = relative(directory, candidate);
  return pathFromDirectory === "" || (
    pathFromDirectory !== ".." &&
    !pathFromDirectory.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromDirectory)
  );
}

export function createConfiguredPrivateDocumentStorage(
  environment: NodeJS.ProcessEnv = process.env,
): PrivateFileDocumentStorage | undefined {
  const storageDirectory = environment.DOCUMENT_STORAGE_DIR?.trim();
  if (!storageDirectory) return undefined;

  const resolvedStorageDirectory = resolve(storageDirectory);
  const webPublicDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../../../web/public");
  if (isWithinDirectory(resolvedStorageDirectory, webPublicDirectory)) return undefined;
  return new PrivateFileDocumentStorage(resolvedStorageDirectory);
}
