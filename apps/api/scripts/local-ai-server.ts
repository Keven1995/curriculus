import { createApp } from "../src/app.js";
import { createConfiguredAnalysisService } from "../src/analyses/configured-analysis-service.js";
import { DataDeletionService } from "../src/privacy/data-deletion-service.js";
import { loadEnvironmentFiles } from "../src/load-environment.js";
import { EphemeralSessionRepository } from "./ephemeral-session-repository.js";

if (process.env.NODE_ENV === "production") {
  throw new Error("The local AI server must never run with NODE_ENV=production.");
}

loadEnvironmentFiles();
if (process.env.NODE_ENV === "production") {
  throw new Error("The local AI server must never run with NODE_ENV=production.");
}

if (process.env.OPENAI_ANALYSIS_ENABLED !== "true") {
  throw new Error("Set OPENAI_ANALYSIS_ENABLED=true in the local .env to opt in to real OpenAI analysis.");
}

const analysisService = createConfiguredAnalysisService();
if (!analysisService) {
  throw new Error("Configure OPENAI_API_KEY, OPENAI_MODEL and OPENAI_TOKENIZER_ENCODING in the server-side .env.");
}

// The local process trusts no forwarded headers and never uses the configured database or payment credentials.
process.env.TRUST_PROXY_HOPS = "0";
const repository = new EphemeralSessionRepository();
const app = createApp({
  production: false,
  webOrigin: "http://127.0.0.1:3000",
  trustedProxyHops: 0,
  analysisService,
  sessionRepository: repository,
  pixPaymentService: null,
  paymentWebhook: null,
  documentService: null,
  dataDeletionService: new DataDeletionService(repository, null),
  logger: true,
});

const cleanupTimer = setInterval(() => {
  void repository.deleteExpiredSessions();
}, 15 * 60_000);
cleanupTimer.unref();
app.addHook("onClose", async () => clearInterval(cleanupTimer));

const port = Number(process.env.PORT ?? "4000");
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error("The local API port must be an integer between 1024 and 65535.");
}

await app.listen({ host: "127.0.0.1", port });
app.log.info({ event: "local_ai_server_started", host: "127.0.0.1", port }, "Local analysis server started");

const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
