import { loadEnvironmentFiles } from "./load-environment.js";
import { createApp } from "./app.js";

loadEnvironmentFiles();

const app = createApp({
  logger: true,
  resumeLayoutImportEnabled: true,
});

const port = Number(process.env.PORT ?? 4000);
await app.listen({ port, host: "0.0.0.0" });
