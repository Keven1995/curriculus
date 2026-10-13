import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadDotEnv } from "dotenv";

export function loadEnvironmentFiles(): void {
  const workingDirectory = process.cwd();
  const monorepoRoot = existsSync(resolve(workingDirectory, "apps/api/package.json"))
    ? workingDirectory
    : resolve(workingDirectory, "../..");
  const files = new Set([
    resolve(workingDirectory, ".env"),
    resolve(monorepoRoot, ".env"),
  ]);

  for (const path of files) {
    if (existsSync(path)) loadDotEnv({ path, quiet: true });
  }
}
