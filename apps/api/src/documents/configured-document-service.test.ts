import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { SessionRepository } from "../persistence/session-repository.js";
import { createConfiguredDocumentService } from "./configured-document-service.js";

const repository = {} as unknown as SessionRepository;

test("keeps document delivery disabled without private storage and a strong signing secret", () => {
  assert.equal(createConfiguredDocumentService(repository, {} as NodeJS.ProcessEnv), undefined);
  assert.equal(createConfiguredDocumentService(repository, {
    DOCUMENT_STORAGE_DIR: "private-documents",
  } as NodeJS.ProcessEnv), undefined);
  assert.equal(createConfiguredDocumentService(repository, {
    DOCUMENT_STORAGE_DIR: "private-documents",
    DOCUMENT_DOWNLOAD_SECRET: "too-short",
  } as NodeJS.ProcessEnv), undefined);
});

test("refuses to place private documents under the web public directory", () => {
  const publicDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../../../web/public/documents");
  assert.equal(createConfiguredDocumentService(repository, {
    DOCUMENT_STORAGE_DIR: publicDirectory,
    DOCUMENT_DOWNLOAD_SECRET: "a-private-test-secret-with-at-least-32-characters",
  } as NodeJS.ProcessEnv), undefined);
});

test("configures private PDF generation with server-only storage credentials", () => {
  const service = createConfiguredDocumentService(repository, {
    DOCUMENT_STORAGE_DIR: "private-documents",
    DOCUMENT_DOWNLOAD_SECRET: "a-private-test-secret-with-at-least-32-characters",
  } as NodeJS.ProcessEnv);

  assert.equal(typeof service?.generateDocument, "function");
  assert.equal(typeof service?.downloadDocument, "function");
});
