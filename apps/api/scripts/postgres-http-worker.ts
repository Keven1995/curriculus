import { createApp } from "../src/app.js";
import { createConfiguredSessionRepository } from "../src/persistence/postgres-session-repository.js";

const connectionString = process.env.DATABASE_URL;
const rateLimitHmacSecret = process.env.RATE_LIMIT_HMAC_SECRET;
const trustedProxyHops = Number(process.env.TRUST_PROXY_HOPS ?? "0");
const limit = Number(process.env.CURRICULUS_RATE_LIMIT_TEST_LIMIT ?? "120");
const windowMs = Number(process.env.CURRICULUS_RATE_LIMIT_TEST_WINDOW_MS ?? "60_000");

if (!connectionString || !rateLimitHmacSecret) {
  throw new Error("Local PostgreSQL HTTP worker configuration is incomplete.");
}

const repository = createConfiguredSessionRepository({ DATABASE_URL: connectionString });
if (!repository) throw new Error("Local PostgreSQL HTTP worker has no repository.");

const app = createApp({
  production: false,
  analysisService: null,
  sessionRepository: repository,
  rateLimitHmacSecret,
  trustedProxyHops,
  rateLimitPolicies: { global: { limit, windowMs } },
});

let shuttingDown = false;
let databaseClosed = false;
async function closeRepository(): Promise<void> {
  if (databaseClosed) return;
  databaseClosed = true;
  await repository!.close?.();
}

if (process.env.NODE_ENV === "test" && process.env.CURRICULUS_TEST_ALLOW_DB_FAILURE === "true") {
  app.post("/__test/close-database", async (_request, reply) => {
    await closeRepository();
    return reply.status(204).send();
  });
}

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await app.close();
  await closeRepository();
}

process.once("SIGTERM", () => {
  void shutdown().then(() => { process.exitCode = 0; });
});
process.once("SIGINT", () => {
  void shutdown().then(() => { process.exitCode = 0; });
});

const address = await app.listen({ host: "127.0.0.1", port: 0 });
process.stdout.write(`READY ${address}\n`);
