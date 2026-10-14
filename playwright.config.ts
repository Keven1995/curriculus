import { defineConfig, devices } from "@playwright/test";
import { randomUUID } from "node:crypto";

const apiUrl = "http://127.0.0.1:4174";
const webUrl = "http://127.0.0.1:4173";
const e2eRunId = randomUUID();
process.env.CURRICULUS_E2E_RUN_ID = e2eRunId;

export default defineConfig({
  testDir: "./e2e",
  globalTeardown: "./e2e/global-teardown.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  timeout: 30_000,
  expect: { timeout: 7_000 },
  use: {
    baseURL: webUrl,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
  webServer: [
    {
      command: "npm run e2e:server --workspace @curriculus/api",
      url: `${apiUrl}/health`,
      timeout: 30_000,
      reuseExistingServer: false,
      env: {
        CURRICULUS_E2E: "true",
        CURRICULUS_E2E_RUN_ID: e2eRunId,
        NODE_ENV: "development",
        PORT: "4174",
        TRUST_PROXY_HOPS: "0",
      },
    },
    {
      command: "npm run dev --workspace @curriculus/web -- --hostname 127.0.0.1 --port 4173",
      url: webUrl,
      timeout: 120_000,
      reuseExistingServer: false,
      env: { NODE_ENV: "development", NEXT_PUBLIC_API_URL: apiUrl },
    },
  ],
});
