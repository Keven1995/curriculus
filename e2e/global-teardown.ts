import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

export default async function globalTeardown(): Promise<void> {
  const runId = process.env.CURRICULUS_E2E_RUN_ID;
  if (!runId || !/^[0-9a-f-]{36}$/i.test(runId)) return;
  await rm(join(tmpdir(), `curriculus-e2e-${runId}`), { recursive: true, force: true });
}
