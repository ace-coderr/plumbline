import Fastify from "fastify";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { elysiumTestnet } from "@plumbline/shared";
import { TxSender, envNumber, makeLogger, throttleRpc } from "@plumbline/shared/node";
import { loadConfig } from "./config.js";
import { MakerBot } from "./bot.js";
import { ReferenceFeed } from "./reference.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = makeLogger(`maker-${cfg.name}`);
  throttleRpc([cfg.rpcUrl], envNumber("MAKER_RPC_PER_SECOND", 3), (m) => log.warn(m));
  const client = createPublicClient({
    chain: elysiumTestnet,
    transport: http(cfg.rpcUrl, { retryCount: 3, timeout: 10_000 }),
    pollingInterval: 100,
  });
  const sender = new TxSender(privateKeyToAccount(cfg.quoterKey), client, elysiumTestnet.id, log);
  const feed = new ReferenceFeed(cfg.referenceUrl, cfg.referenceCoin, log);
  const bot = new MakerBot(cfg, client, sender, feed, log);
  // Retry startup reads rather than dying on a transient RPC error.
  for (let attempt = 1; ; attempt++) {
    try {
      await bot.start();
      break;
    } catch (err) {
      if (attempt >= 10) throw err;
      log.warn("start failed; retrying", { attempt, err: err instanceof Error ? err.message.split("\n")[0] : String(err) });
      await new Promise((r) => setTimeout(r, 2_000 * attempt));
    }
  }

  const app = Fastify({ logger: false });
  app.get("/health", async (_req, reply) => {
    const age = feed.age();
    const ok = age <= cfg.maxReferenceAgeMs && bot.stats.quoting;
    return reply.code(ok ? 200 : 503).send({
      ok,
      vault: cfg.vault,
      spreadBps: cfg.spreadBps,
      referenceAgeMs: Number.isFinite(age) ? age : null,
      ...bot.stats,
    });
  });
  await app.listen({ port: cfg.port, host: "127.0.0.1" });
  log.info("maker bot up", {
    vault: cfg.vault,
    spreadBps: cfg.spreadBps,
    size: cfg.size,
    refreshMs: cfg.refreshMs,
    port: cfg.port,
  });

  const shutdown = () => {
    void bot.stop().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
