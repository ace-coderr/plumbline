import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { elysiumTestnet } from "@plumbline/shared";
import { TxSender, envNumber, makeLogger, throttleRpc } from "@plumbline/shared/node";
import { loadConfig } from "./config.js";
import { Keeper } from "./keeper.js";
import { Stats } from "./stats.js";
import { buildServer } from "./server.js";

const log = makeLogger("keeper");

async function main(): Promise<void> {
  const cfg = loadConfig();
  throttleRpc([cfg.rpcUrl], envNumber("KEEPER_RPC_PER_SECOND", 3), (m) => log.warn(m));
  const client = createPublicClient({
    chain: elysiumTestnet,
    transport: http(cfg.rpcUrl, { batch: { wait: 10 }, retryCount: 3, timeout: 10_000 }),
    batch: { multicall: false },
    pollingInterval: 100,
  });
  // Probes go out on their own client (optionally another endpoint) so a send never queues behind
  // gate polls: the gate stays open for ~8 blocks, about a second.
  const sendUrl = process.env.KEEPER_SEND_RPC_URL || cfg.rpcUrl;
  // The send endpoint gets its own pacing and rate-limit retry, independent of the poll queue.
  if (sendUrl !== cfg.rpcUrl) throttleRpc([sendUrl], envNumber("KEEPER_SEND_RPC_PER_SECOND", 2), (m) => log.warn(m));
  const sendClient =
    sendUrl === cfg.rpcUrl
      ? client
      : createPublicClient({ chain: elysiumTestnet, transport: http(sendUrl, { retryCount: 3, timeout: 10_000 }), pollingInterval: 100 });
  const account = privateKeyToAccount(cfg.privateKey);
  const sender = new TxSender(account, sendClient, elysiumTestnet.id, log);
  const stats = new Stats();
  stats.load();

  const keeper = new Keeper(cfg, client, sender, stats, log);
  await keeper.start();

  const app = buildServer(keeper, stats, account.address);
  await app.listen({ port: cfg.port, host: cfg.host });
  log.info("keeper up", { address: account.address, port: cfg.port, pollMs: cfg.pollMs });

  const shutdown = () => {
    keeper.stop();
    void app.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err: unknown) => {
  log.error("fatal", { err: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
