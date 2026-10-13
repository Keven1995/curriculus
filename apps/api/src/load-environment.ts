import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadDotEnv } from "dotenv";

type EnvironmentFileOptions = { path: string; quiet: true };
type EnvironmentFileLoader = (options: EnvironmentFileOptions) => unknown;
type PathExists = (path: string) => boolean;

export function loadEnvironmentFiles(
  environment: NodeJS.ProcessEnv = process.env,
  workingDirectory = process.cwd(),
  loadFile: EnvironmentFileLoader = (options) => loadDotEnv(options),
  pathExists: PathExists = existsSync,
): void {
  // Production secrets must come from the deployment secret manager, never a checked-out .env file.
  if (environment.NODE_ENV === "production") return;

  const monorepoRoot = pathExists(resolve(workingDirectory, "apps/api/package.json"))
    ? workingDirectory
    : resolve(workingDirectory, "../..");
  const files = new Set([
    resolve(workingDirectory, ".env"),
    resolve(monorepoRoot, ".env"),
  ]);

  for (const path of files) {
    if (pathExists(path)) loadFile({ path, quiet: true });
  }
}
