import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { loadEnvironmentFiles } from "./load-environment.js";

test("does not load dotenv files in production", () => {
  const loaded: string[] = [];
  loadEnvironmentFiles(
    { NODE_ENV: "production" } as NodeJS.ProcessEnv,
    "C:\\service",
    (options) => { loaded.push(options.path); },
  );
  assert.deepEqual(loaded, []);
});

test("loads local environment files outside production without overriding existing values", () => {
  const workingDirectory = resolve("C:/curriculus/apps/api");
  const rootDirectory = resolve(workingDirectory, "../..");
  const loaded: string[] = [];
  loadEnvironmentFiles(
    { NODE_ENV: "development" } as NodeJS.ProcessEnv,
    workingDirectory,
    (options) => { loaded.push(options.path); },
    (path) => path === resolve(workingDirectory, ".env") || path === resolve(rootDirectory, ".env"),
  );
  assert.deepEqual(loaded, [resolve(workingDirectory, ".env"), resolve(rootDirectory, ".env")]);
});
