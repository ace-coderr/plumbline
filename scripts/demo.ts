/**
 * Demo actions against the seeded market (WHYPE against the seed's quote token, PLUMBUSD).
 *
 *   pnpm demo swap [amount]   maker A's owner key buys WHYPE through the router, then sells half back
 *   pnpm demo fake-fill       a rogue vault quotes size it does not hold; a taker hits it, the router
 *                             catches the revert, verifies the shortfall and slashes the rogue's bond
 *
 * Every transaction is recorded in the gas ledger (tag SEED_LEDGER_TAG, default "live").
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createPublicClient,
  decodeEventLog,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  http,
  parseUnits,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  deployment,
  elysiumTestnet,
  plumbCampaignsAbi,
  plumbQuoteAbi,
  plumbQuoteFactoryAbi,
  plumbRouterAbi,
  txUrl,
  wrappedNativeAbi,
} from "@plumbline/shared";
import { TxSender, makeLogger, throttleRpc } from "@plumbline/shared/node";
import { hexKey, loadEnv, ROOT } from "./lib/env.js";
import { Ledger } from "./lib/ledger.js";

loadEnv();
const log = makeLogger("demo");
const rpcUrl = process.env.ELYSIUM_RPC_URL ?? "https://testnet-rpc.elysium.kinetiq.xyz";
throttleRpc([rpcUrl], Number(process.env.DEMO_RPC_PER_SECOND ?? 1.5), (m) => log.warn(m));
const client = createPublicClient({ chain: elysiumTestnet, transport: http(rpcUrl, { retryCount: 3 }), pollingInterval: 100 });
const W = deployment.tokens.WHYPE;
const { router, factory, campaigns } = deployment.contracts;
const mintAbi = [
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [],
  },
] as const;

interface SeedCp {
  demoToken?: `0x${string}`;
  campaignId?: number;
}

function seedCheckpoint(chainId: number): SeedCp {
  const p = join(ROOT, "data", `seed-${chainId}.json`);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as SeedCp) : {};
}

function events(receipt: TransactionReceipt) {
  const out: { name: string; args: Record<string, unknown> }[] = [];
  for (const l of receipt.logs) {
    for (const abi of [plumbRouterAbi, plumbCampaignsAbi, plumbQuoteAbi] as const) {
      try {
        const e = decodeEventLog({ abi, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
        out.push({ name: e.eventName, args: e.args as Record<string, unknown> });
        break;
      } catch {
        // try the next ABI
      }
    }
  }
  return out;
}

async function ctx() {
  const chainId = await client.getChainId();
  const cp = seedCheckpoint(chainId);
  if (!cp.demoToken || !cp.campaignId) throw new Error("seed first: pnpm seed");
  const ledger = Ledger.forRun(chainId, process.env.SEED_LEDGER_TAG ?? "live");
  const mk = (k: string) => new TxSender(privateKeyToAccount(hexKey(k)), client, chainId, log);
  return { chainId, Q: cp.demoToken, campaignId: cp.campaignId, ledger, mk };
}

async function approveIfNeeded(ledger: Ledger, s: TxSender, token: `0x${string}`, spender: `0x${string}`, amount: bigint) {
  const allowance = await client.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [s.address, spender] });
  if (allowance >= amount) return;
  await ledger.send(s, "approve", { to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }) });
}

async function swap(amount: string) {
  const { Q, ledger, mk } = await ctx();
  const deployer = mk("DEPLOYER_PRIVATE_KEY");
  // Maker A's owner key: no running service sends from it, so nonces never collide.
  const taker = mk("MAKER_A_PRIVATE_KEY");
  const amountIn = parseUnits(amount, 6);
  const bal = await client.readContract({ address: Q, abi: erc20Abi, functionName: "balanceOf", args: [taker.address] });
  if (bal < amountIn) {
    await ledger.send(deployer, "mint PLUMBUSD", { to: Q, data: encodeFunctionData({ abi: mintAbi, functionName: "mint", args: [taker.address, amountIn - bal] }) });
  }
  await approveIfNeeded(ledger, taker, Q, router, amountIn);
  const [preview] = await client.readContract({ address: router, abi: plumbRouterAbi, functionName: "previewSwap", args: [W.address, Q, true, amountIn] });
  const { sent, receipt } = await ledger.send(taker, "swapExactIn", {
    to: router,
    data: encodeFunctionData({ abi: plumbRouterAbi, functionName: "swapExactIn", args: [W.address, Q, true, amountIn, (preview * 995n) / 1000n, taker.address] }),
    abi: plumbRouterAbi,
  });
  const bought = events(receipt).find((e) => e.name === "Swapped")?.args.amountOut as bigint | undefined;
  log.info("bought WHYPE", { plumbusd: amount, whype: formatUnits(bought ?? 0n, W.decimals), tx: txUrl(sent.hash) });

  const back = (bought ?? 0n) / 2n;
  if (back === 0n) return;
  await approveIfNeeded(ledger, taker, W.address, router, back);
  const [previewBack] = await client.readContract({ address: router, abi: plumbRouterAbi, functionName: "previewSwap", args: [W.address, Q, false, back] });
  const r2 = await ledger.send(taker, "swapExactIn", {
    to: router,
    data: encodeFunctionData({ abi: plumbRouterAbi, functionName: "swapExactIn", args: [W.address, Q, false, back, (previewBack * 995n) / 1000n, taker.address] }),
    abi: plumbRouterAbi,
  });
  log.info("sold half back", { whype: formatUnits(back, W.decimals), tx: txUrl(r2.sent.hash) });
}

interface RogueState {
  vault?: `0x${string}`;
}

async function fakeFill() {
  const { chainId, Q, campaignId, ledger, mk } = await ctx();
  const rogue = mk("DEPLOYER_PRIVATE_KEY");
  const taker = mk("MAKER_A_PRIVATE_KEY");
  const statePath = join(ROOT, "data", `demo-rogue-${chainId}.json`);
  const st: RogueState = existsSync(statePath) ? (JSON.parse(readFileSync(statePath, "utf8")) as RogueState) : {};
  const save = () => {
    mkdirSync(join(ROOT, "data"), { recursive: true });
    writeFileSync(statePath, JSON.stringify(st, null, 2));
  };
  const sliver = parseUnits(process.env.DEMO_ROGUE_WHYPE ?? "0.0002", W.decimals);

  // 1. The rogue vault, holding a sliver of WHYPE.
  if (!st.vault) {
    const { receipt } = await ledger.send(rogue, "createVault", {
      to: factory,
      data: encodeFunctionData({ abi: plumbQuoteFactoryAbi, functionName: "createVault", args: [W.address, Q, rogue.address] }),
    });
    for (const l of receipt.logs) {
      try {
        const e = decodeEventLog({ abi: plumbQuoteFactoryAbi, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
        if (e.eventName === "VaultCreated") st.vault = e.args.vault;
      } catch {
        // other logs
      }
    }
    if (!st.vault) throw new Error("vault not created");
    save();
    await ledger.send(rogue, "wrap HYPE", { to: W.address, data: encodeFunctionData({ abi: wrappedNativeAbi, functionName: "deposit" }), value: sliver });
    await ledger.send(rogue, "transfer WHYPE", { to: W.address, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [st.vault, sliver] }) });
    log.info("rogue vault", { vault: st.vault, holds: formatUnits(sliver, W.decimals) + " WHYPE" });
  }
  const vault = st.vault;

  // 2. Bond it into the seeded campaign so there is something to slash.
  const id = BigInt(campaignId);
  const reg = await client.readContract({ address: campaigns, abi: plumbCampaignsAbi, functionName: "registration", args: [id, vault] });
  if (reg.bond === 0n) {
    const terms = await client.readContract({ address: campaigns, abi: plumbCampaignsAbi, functionName: "terms", args: [id] });
    await ledger.send(rogue, "mint PLUMBUSD", { to: Q, data: encodeFunctionData({ abi: mintAbi, functionName: "mint", args: [rogue.address, terms.makerBond] }) });
    await approveIfNeeded(ledger, rogue, Q, campaigns, terms.makerBond);
    await ledger.send(rogue, "register + bond", {
      to: campaigns,
      data: encodeFunctionData({ abi: plumbCampaignsAbi, functionName: "register", args: [id, vault] }),
      abi: plumbCampaignsAbi,
    });
    log.info("rogue bonded", { campaign: campaignId, bond: formatUnits(terms.makerBond, 6) + " PLUMBUSD" });
  }

  // 3. The taker needs quote tokens.
  const spend = parseUnits(process.env.DEMO_FAKE_SPEND ?? "0.05", 6);
  const bal = await client.readContract({ address: Q, abi: erc20Abi, functionName: "balanceOf", args: [taker.address] });
  if (bal < spend) {
    await ledger.send(rogue, "mint PLUMBUSD", { to: Q, data: encodeFunctionData({ abi: mintAbi, functionName: "mint", args: [taker.address, spend - bal] }) });
  }
  await approveIfNeeded(ledger, taker, Q, router, spend);
  // The taker's gas comes out of the deployer's demo allowance (see pnpm budget).
  const takerHype = await client.getBalance({ address: taker.address });
  const takerNeeds = 600_000n * 130_000_000n; // fee cap is 1.25x a gas price that drifts just above 0.1 gwei
  if (takerHype < takerNeeds) {
    await ledger.send(rogue, "transfer HYPE", { to: taker.address, data: "0x", value: takerNeeds - takerHype, gas: 30_000n });
  }

  // 4. Undercut the honest asks with 10x the size the vault holds, then get hit immediately.
  const book = await client.readContract({ address: router, abi: plumbRouterAbi, functionName: "book", args: [W.address, Q] });
  const honest = book.filter((b) => b.live && b.vault.toLowerCase() !== vault.toLowerCase() && b.quote.askSize > 0n);
  if (honest.length === 0) throw new Error("no honest live quotes to undercut; are the maker bots running?");
  const bestAsk = honest.reduce((m, b) => (b.quote.askPx < m ? b.quote.askPx : m), honest[0]!.quote.askPx);
  const ask = bestAsk - bestAsk / 10_000n;
  const bid = ask - ask / 1_000n;
  // The rogue quote lives 2s and each RPC round trip here costs hundreds of ms, so send the quote and
  // the swap back to back without waiting on the first receipt. If the swap still lands after the
  // quote expired, it fills from the honest vaults instead; check and retry a couple of times.
  process.env.TX_MAX_FEE_WEI ??= "130000000";
  await taker.resync();
  let receipt: TransactionReceipt | null = null;
  let sent: { hash: `0x${string}` } | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const quoteTx = await rogue.send({
      to: vault,
      data: encodeFunctionData({ abi: plumbQuoteAbi, functionName: "setQuote", args: [bid, ask, sliver / 10n, sliver * 10n] }),
      gas: 150_000n,
      label: "rogue setQuote",
    });
    await new Promise((r) => setTimeout(r, 400));
    sent = await taker.send({
      to: router,
      data: encodeFunctionData({ abi: plumbRouterAbi, functionName: "swapExactIn", args: [W.address, Q, true, spend, 0n, taker.address] }),
      // Measured at ~279k on the fork; 600k leaves room without demanding a large prefund.
      gas: 600_000n,
      label: "swap",
    });
    ledger.record("setQuote", rogue.address, await rogue.wait(quoteTx.hash));
    receipt = await taker.wait(sent.hash);
    const hit = events(receipt).some((e) => e.name === "FillFailed");
    ledger.record(hit ? "swap hitting rogue (penalize)" : "swapExactIn", taker.address, receipt);
    if (hit) break;
    log.warn("swap landed after the rogue quote expired; retrying", { attempt });
  }
  if (!receipt || !sent) throw new Error("no swap sent");
  const evs = events(receipt);
  const failed = evs.find((e) => e.name === "FillFailed");
  const swapped = evs.find((e) => e.name === "Swapped");
  log.info("taker swap", { tx: txUrl(sent.hash) });
  log.info("fill failed on rogue vault", { penalized: failed?.args.penalized, status: failed?.args.status });
  for (const p of evs.filter((e) => e.name === "Penalized")) {
    log.info("bond slashed", {
      campaign: String(p.args.id),
      slashed: formatUnits(p.args.slashed as bigint, 6),
      toTaker: formatUnits(p.args.toReporter as bigint, 6),
      toHonestMakers: formatUnits(p.args.toMakers as bigint, 6),
    });
  }
  log.info("taker still filled by honest vaults", {
    whype: formatUnits((swapped?.args.amountOut as bigint | undefined) ?? 0n, W.decimals),
    refunded: formatUnits((swapped?.args.refunded as bigint | undefined) ?? 0n, 6),
  });

  // 5. Pull the fake quote and leave the campaign, so later probes stop paying to check it.
  await ledger.send(rogue, "cancel", { to: vault, data: encodeFunctionData({ abi: plumbQuoteAbi, functionName: "cancel" }), gas: 100_000n });
  const regNow = await client.readContract({ address: campaigns, abi: plumbCampaignsAbi, functionName: "registration", args: [id, vault] });
  if (regNow.unbondRequestedAt !== 0n) return;
  await ledger.send(rogue, "requestUnbond", {
    to: campaigns,
    data: encodeFunctionData({ abi: plumbCampaignsAbi, functionName: "requestUnbond", args: [id, vault] }),
    abi: plumbCampaignsAbi,
  });
}

const [cmd, arg] = process.argv.slice(2);
const run = cmd === "swap" ? swap(arg ?? "0.02") : cmd === "fake-fill" ? fakeFill() : Promise.reject(new Error("usage: pnpm demo <swap [amount] | fake-fill>"));
run.catch((err: unknown) => {
  log.error("demo failed", { err: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
