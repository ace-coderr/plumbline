/** Standalone indexer: the service plus its own HTTP port. Used for local development. */
import Fastify from "fastify";
import { envNumber, envString, loadRootEnv, makeLogger } from "@plumbline/shared/node";
import { startIndexer } from "./service.js";

loadRootEnv();
const log = makeLogger("indexer");

async function main(): Promise<void> {
  const indexer = await startIndexer(log);
  const app = Fastify({ logger: false });
  indexer.register(app);
  const port = envNumber("INDEXER_PORT", 8788);
  await app.listen({ port, host: envString("INDEXER_HOST", "0.0.0.0") });
  log.info("api up", { port });

  const shutdown = () => {
    void app.close().then(() => {
      indexer.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err: unknown) => {
  log.error("fatal", { err: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
