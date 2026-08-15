import Fastify from "fastify";
import { pool } from "./db";
import { runMigrations } from "./migrate";
import { logsRoutes } from "./routes/logs";

const PORT = Number(process.env.PORT ?? 8080);
const HOST = "0.0.0.0";

const app = Fastify({ logger: false });

let ready = false;

app.addHook("onRequest", async (req, reply) => {
  if (!ready && req.url !== "/health") {
    reply.code(503).send({ status: "starting" });
  }
});

app.get("/health", async (_req, reply) => {
  if (!ready) {
    reply.code(503);
    return { status: "starting" };
  }
  return { status: "ok" };
});

app.register(logsRoutes);

async function start(): Promise<void> {
  await app.listen({ port: PORT, host: HOST });
  console.log(`listening on ${HOST}:${PORT}, running migrations...`);

  try {
    await runMigrations(pool);
    ready = true;
    console.log("migrations complete, ready to accept traffic");
  } catch (err) {
    console.error("migration failed", err);
    process.exit(1);
  }
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
