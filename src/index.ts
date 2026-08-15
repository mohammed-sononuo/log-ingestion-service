import Fastify from "fastify";

const PORT = Number(process.env.PORT ?? 8080);
const HOST = "0.0.0.0";

const app = Fastify({ logger: false });

app.get("/health", async () => {
  return { status: "ok" };
});

app.listen({ port: PORT, host: HOST }, (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`listening on ${address}`);
});
