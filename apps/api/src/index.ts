import { createApp } from "./app.js";

const app = createApp({ logger: true });

const port = Number(process.env.PORT ?? 4000);
await app.listen({ port, host: "0.0.0.0" });
