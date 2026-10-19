/**
 * Size the whole demo from measured gas.
 *
 *   pnpm budget            print the plan
 *   pnpm budget --write    also write SEED_* / budget-guard values into .env
 *
 * Inputs: the fork gas ledger (data/gas-99801-fork.json, from `pnpm seed` + `pnpm measure` +
 * `pnpm demo fake-fill` on a local fork), the live deployer balance and gas price, and the live
 * average block time from the explorer. A fixed share of the balance (BUDGET_HEADROOM, default 30%)
 * is never allocated.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, formatEther, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { elysiumTestnet } from "@plumbline/shared";
import { hexKey, loadEnv, ROOT } from "./lib/env.js";
import type { LedgerEntry } from "./lib/ledger.js";
import { writeEnv } from "./lib/envfile.js";

loadEnv();
const num = (k: string, d: number) => Number(process.env[k] ?? d);
const P = {
  headroom: num("BUDGET_HEADROOM", 0.3),
  keeperHours: num("BUDGET_KEEPER_HOURS", 2),
  botMinutes: num("BUDGET_BOT_MINUTES", 25),
  refreshMs: num("BUDGET_REFRESH_MS", 500),
  epochSeconds: num("BUDGET_EPOCH_SECONDS", 300),
  vaultWhype: process.env.BUDGET_VAULT_WHYPE ?? "0.001",
  rogueWhype: process.env.BUDGET_ROGUE_WHYPE ?? "0.0002",
  feeHeadroom: 1.25, // TxSender caps maxFeePerGas at 1.25x the gas price
};
const GATE_ODDS = 64;
const LIVE_RPC = process.env.BUDGET_RPC_URL ?? "https://testnet-rpc.elysium.kinetiq.xyz";

function means(entries: LedgerEntry[]): Map<string, number> {
  const by = new Map<string, number[]>();
  for (const e of entries) by.set(e.action, [...(by.get(e.action) ?? []), e.gasUsed]);
  return new Map([...by].map(([k, v]) => [k, v.reduce((a, b) => a + b, 0) / v.length]));
}

async function main(): Promise<void> {
  const ledgerPath = join(ROOT, "data", "gas-99801-fork.json");
  if (!existsSync(ledgerPath)) throw new Error("no fork gas ledger; run seed + measure against a fork first");
  const g = means(JSON.parse(readFileSync(ledgerPath, "utf8")) as LedgerEntry[]);
  const gas = (a: string) => {
    const v = g.get(a);
    if (v === undefined) throw new Error(`no measurement for "${a}"`);
    return v;
  };

  const client = createPublicClient({ chain: elysiumTestnet, transport: http(LIVE_RPC, { retryCount: 3 }) });
  const deployer = privateKeyToAccount(hexKey("DEPLOYER_PRIVATE_KEY")).address;
  const [balance, gasPrice] = await Promise.all([client.getBalance({ address: deployer }), client.getGasPrice()]);
  let blockMs = 121;
  try {
    const s = (await (await fetch("https://testnet-api.elysium.kinetiq.xyz/api/v2/stats")).json()) as { average_block_time?: number };
    if (s.average_block_time) blockMs = s.average_block_time;
  } catch {
    // keep the default
  }

  const price = Number(gasPrice) / 1e18; // HYPE per gas
  const H = (gasUnits: number) => gasUnits * price;
  const prefund = (limitGas: number) => limitGas * price * P.feeHeadroom; // balance a wallet must hold to send

  const bal = Number(formatEther(balance));
  const spendable = bal * (1 - P.headroom);

  // One-off transactions, counted exactly as the seed and demos send them.
  const seedGas =
    gas("deploy DemoQuoteToken") +
    5 * gas("transfer HYPE") +
    3 * gas("createVault") +
    5 * gas("mint PLUMBUSD") +
    gas("wrap HYPE") +
    2 * gas("transfer WHYPE") +
    3 * gas("approve") +
    gas("openCampaign") +
    2 * gas("register + bond");
  const fakeFillGas =
    gas("createVault") + gas("wrap HYPE") + gas("transfer WHYPE") + 2 * gas("mint PLUMBUSD") + 2 * gas("approve") +
    gas("register + bond") + gas("setQuote") + gas("swap hitting rogue (penalize)") + gas("cancel") + gas("requestUnbond");
  const swapDemoGas = gas("mint PLUMBUSD") + 2 * gas("approve") + 2 * gas("swapExactIn");
  const inventory = 2 * Number(P.vaultWhype) + Number(P.rogueWhype);

  // Makers: each sends createVault, approve, register from its own key.
  const makerGas = gas("createVault") + gas("approve") + gas("register + bond");
  const makerFund = H(makerGas) + prefund(gas("createVault") * 1.3) - H(gas("createVault"));

  // Bots: refreshes per second x seconds x gas per setQuote, plus a floor to cancel with.
  const refreshesPerBot = (P.botMinutes * 60 * 1000) / P.refreshMs;
  const botGasEach = refreshesPerBot * gas("setQuote");
  const quoterFloor = prefund(150_000) + H(gas("cancel"));
  const quoterFund = H(botGasEach) + quoterFloor;

  // Keeper: what is left, after one-offs, inventory and both bots.
  const oneOffs = H(seedGas) + 2 * makerFund + H(fakeFillGas) + H(swapDemoGas) + inventory;
  const keeperAlloc = spendable - oneOffs - 2 * quoterFund;
  const epochs = Math.ceil((P.keeperHours * 3600) / P.epochSeconds);
  const gateMeanSec = (GATE_ODDS * blockMs) / 1000;
  const keeperFloor = prefund(gas("probe (2 vaults)") * 1.3);
  const keeperCost = (interval: number) => {
    const probes = (P.keeperHours * 3600) / (interval + gateMeanSec);
    return { probes, hype: H(probes * gas("probe (2 vaults)") + epochs * gas("settle")) + keeperFloor };
  };
  let interval = 1;
  while (keeperCost(interval).hype > keeperAlloc && interval < P.epochSeconds - 1) interval++;
  const kc = keeperCost(interval);
  if (kc.hype > keeperAlloc) throw new Error("keeper cannot run the target hours inside this budget; lower BUDGET_BOT_MINUTES");
  const probeFeeBps = Math.max(1, Math.min(10, Math.floor(5000 / Math.floor(P.epochSeconds / interval))));

  const totalPlanned = oneOffs + 2 * quoterFund + kc.hype;
  const fmt = (x: number) => x.toFixed(6);
  const rows: [string, string, string][] = [
    ["gas price", `${Number(gasPrice) / 1e9} gwei`, "live eth_gasPrice"],
    ["block time", `${blockMs} ms`, "explorer average"],
    ["balance", fmt(bal), "deployer, live"],
    [`headroom ${P.headroom * 100}%`, fmt(bal * P.headroom), "never allocated"],
    ["spendable", fmt(spendable), ""],
    ["seed one-offs", fmt(H(seedGas)), `${Math.round(seedGas).toLocaleString()} gas`],
    ["maker wallets x2", fmt(2 * makerFund), `createVault + approve + bond, ${Math.round(makerGas).toLocaleString()} gas each`],
    ["WHYPE inventory", fmt(inventory), `${P.vaultWhype} per vault + ${P.rogueWhype} rogue (locked, recoverable)`],
    ["rogue fill demo", fmt(H(fakeFillGas)), `${Math.round(fakeFillGas).toLocaleString()} gas`],
    ["swap demo", fmt(H(swapDemoGas)), `${Math.round(swapDemoGas).toLocaleString()} gas`],
    [
      "maker bots x2",
      fmt(2 * quoterFund),
      `${P.botMinutes} min x ${1000 / P.refreshMs}/s x ${Math.round(gas("setQuote")).toLocaleString()} gas = ${Math.round(refreshesPerBot)} refreshes each`,
    ],
    [
      "keeper",
      fmt(kc.hype),
      `${Math.round(kc.probes)} probes x ${Math.round(gas("probe (2 vaults)")).toLocaleString()} gas + ${epochs} settles over ${P.keeperHours}h`,
    ],
    ["total planned", fmt(totalPlanned), `${((totalPlanned / bal) * 100).toFixed(1)}% of balance`],
  ];
  console.log("\nPlumbline demo budget (HYPE)\n");
  for (const [k, v, n] of rows) console.log(`${k.padEnd(20)} ${v.padStart(12)}   ${n}`);
  console.log(
    `\nprobe interval: ${interval}s minimum + ~${gateMeanSec.toFixed(1)}s mean gate wait -> one probe every ~${(interval + gateMeanSec).toFixed(1)}s`,
  );
  console.log(`maker bots stay live for ~${P.botMinutes} min at ${P.refreshMs}ms refresh; keeper runs ${P.keeperHours}h`);

  if (process.argv.includes("--write")) {
    const wei = (x: number) => parseEther(x.toFixed(18)).toString();
    writeEnv({
      SEED_MAKER_HYPE: makerFund.toFixed(8),
      SEED_QUOTER_HYPE: quoterFund.toFixed(8),
      SEED_KEEPER_HYPE: kc.hype.toFixed(8),
      SEED_VAULT_WHYPE: P.vaultWhype,
      SEED_EPOCHS: String(epochs),
      SEED_EPOCH_LENGTH: String(P.epochSeconds),
      SEED_MIN_PROBE_INTERVAL: String(interval),
      SEED_PROBE_FEE_BPS: String(probeFeeBps),
      DEMO_ROGUE_WHYPE: P.rogueWhype,
      MAKER_A_STOP_BELOW_WEI: wei(quoterFloor),
      MAKER_B_STOP_BELOW_WEI: wei(quoterFloor),
      MAKER_A_REFRESH_MS: String(P.refreshMs),
      MAKER_B_REFRESH_MS: String(P.refreshMs),
      KEEPER_STOP_BELOW_WEI: wei(keeperFloor * 0.5),
    });
    console.log("\nwrote budget values to .env");
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
