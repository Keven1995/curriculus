import cors from "@fastify/cors";
import Fastify from "fastify";

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: process.env.WEB_ORIGIN ?? "http://localhost:3000",
});

app.get("/health", async () => ({ status: "ok", service: "curriculus-api" }));

const port = Number(process.env.PORT ?? 4000);
await app.listen({ port, host: "0.0.0.0" });
