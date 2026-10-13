import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { SessionRepository } from "../persistence/session-repository.js";
import { createConfiguredDataDeletionService } from "./configured-data-deletion-service.js";

const repository = {} as unknown as SessionRepository;

test("keeps the self-service deletion flow available without document storage for analysis-only sessions", () => {
  const service = createConfiguredDataDeletionService(repository, {} as NodeJS.ProcessEnv);
  assert.equal(typeof service.deleteSessionData, "function");
});

test("does not configure document removal with a directory inside the public web assets", () => {
  const publicDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../../../web/public/documents");
  const service = createConfiguredDataDeletionService(repository, {
    DOCUMENT_STORAGE_DIR: publicDirectory,
  } as NodeJS.ProcessEnv);
  assert.equal(typeof service.deleteSessionData, "function");
});
