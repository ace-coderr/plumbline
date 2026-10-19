/**
 * Measure per-action gas on a local anvil fork of Elysium, after `pnpm seed` has run against it.
 * Exercises the recurring actions the seed does not: setQuote, probe, settle, cancel and a swap.
 * Results go to the same gas ledger as the seed (tag SEED_LEDGER_TAG, default "fork") and feed
 * `pnpm budget`.
 *
 *   ELYSIUM_RPC_URL=http://127.0.0.1:8545 SEED_LEDGER_TAG=fork pnpm measure
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, encodeFunctionData, erc20Abi, http, parseUnits, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { deployment, elysiumTestnet, plumbCampaignsAbi, plumbQuoteAbi, plumbRouterAbi, toPx } from "@plumbline/shared";
import { TxSender, makeLogger } from "@plumbline/shared/node";
import { hexKey, loadEnv, ROOT } from "./lib/env.js";
import { Ledger } from "./lib/ledger.js";

loadEnv();
const log = makeLogger("measure");
const rpcUrl = process.env.ELYSIUM_RPC_URL ?? "http://127.0.0.1:8545";
if (!/127\.0\.0\.1|localhost/.test(rpcUrl)) throw new Error("measure uses anvil cheats; point ELYSIUM_RPC_URL at a local fork");

interface Cp {
  demoToken: `0x${string}`;
  vaultA: `0x${string}`;
  vaultB: `0x${string}`;
  campaignId: number;
}

async function main(): Promise<void> {
  const client = createPublicClient({ chain: elysiumTestnet, transport: http(rpcUrl), pollingInterval: 100 });
  const chainId = await client.getChainId();
  const cpPath = join(ROOT, "data", `seed-${chainId}.json`);
  if (!existsSync(cpPath)) throw new Error("seed the fork first");
  const cp = JSON.parse(readFileSync(cpPath, "utf8")) as Cp;
  const ledger = Ledger.forRun(chainId, process.env.SEED_LEDGER_TAG ?? "fork");
  const mk = (k: string) => new TxSender(privateKeyToAccount(hexKey(k)), client, chainId, log);
  const qa = mk("QUOTER_A_PRIVATE_KEY");
  const qb = mk("QUOTER_B_PRIVATE_KEY");
  const keeper = mk("KEEPER_PRIVATE_KEY");
  const deployer = mk("DEPLOYER_PRIVATE_KEY");
  const taker = mk("MAKER_A_PRIVATE_KEY");
  const id = BigInt(cp.campaignId);
  /** Raw JSON-RPC for anvil-only methods viem does not type. */
  const rpc = async (method: string, params: unknown[]): Promise<unknown> => {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return ((await res.json()) as { result?: unknown }).result;
  };

  const quote = async (s: TxSender, vault: `0x${string}`, mid: number, halfBps: number) => {
    const bid = toPx((mid * (1 - halfBps / 10_000)).toFixed(6));
    const ask = toPx((mid * (1 + halfBps / 10_000)).toFixed(6));
    const size = parseUnits("0.001", 18);
    await ledger.send(s, "setQuote", {
      to: vault,
      data: encodeFunctionData({ abi: plumbQuoteAbi, functionName: "setQuote", args: [bid, ask, size, size] }),
      gas: 150_000n,
    });
  };

  // Quote refreshes with a moving mid, as a live bot would send them.
  for (let i = 0; i < 12; i++) {
    const mid = 42.5 + (i % 3) * 0.01;
    await quote(qa, cp.vaultA, mid, 6);
    await quote(qb, cp.vaultB, mid, 12);
  }

  // Probes: jump past the interval, mine until the gate opens, re-quote, probe.
  const terms = await client.readContract({ address: deployment.contracts.campaigns, abi: plumbCampaignsAbi, functionName: "terms", args: [id] });
  let landed = 0;
  for (let attempt = 0; landed < 8 && attempt < 40; attempt++) {
    if (attempt === 0 || landed > 0) await rpc("evm_increaseTime", [terms.minProbeInterval]);
    await quote(qa, cp.vaultA, 42.5, 6);
    await quote(qb, cp.vaultB, 42.5, 12);
    for (let guard = 0; guard < 2_000; guard++) {
      const open = await client.readContract({ address: deployment.contracts.campaigns, abi: plumbCampaignsAbi, functionName: "probeGateOpen", args: [id] });
      if (open) break;
      await rpc("evm_mine", []);
    }
    const sent = await keeper.send({
      to: deployment.contracts.campaigns,
      data: encodeFunctionData({ abi: plumbCampaignsAbi, functionName: "probe", args: [id] }),
      gas: 600_000n,
      label: "probe",
    });
    const receipt = await keeper.wait(sent.hash);
    if (receipt.status === "success") {
      ledger.record("probe (2 vaults)", keeper.address, receipt);
      landed += 1;
      log.info("probe", { gas: Number(receipt.gasUsed) });
    } else {
      // A keeper pays for these too when the gate closes under it.
      ledger.record("probe (reverted: gate closed)", keeper.address, receipt);
    }
  }

  // A taker swap against the live quotes.
  const Q = cp.demoToken;
  await ledger.send(deployer, "mint PLUMBUSD", {
    to: Q,
    data: encodeFunctionData({
      abi: [{ type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] }] as const,
      functionName: "mint",
      args: [taker.address, parseUnits("1", 6)],
    }),
  });
  await ledger.send(taker, "approve", { to: Q, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [deployment.contracts.router, parseUnits("1", 6)] }) });
  for (let attempt = 0; attempt < 6; attempt++) {
    await quote(qa, cp.vaultA, 42.5, 6);
    await quote(qb, cp.vaultB, 42.5, 12);
    const sent = await taker.send({
      to: deployment.contracts.router,
      data: encodeFunctionData({
        abi: plumbRouterAbi,
        functionName: "swapExactIn",
        args: [deployment.tokens.WHYPE.address, Q, true, parseUnits("0.02", 6), 0n, taker.address],
      }),
      gas: 600_000n,
      label: "swap",
    });
    const receipt = await taker.wait(sent.hash);
    if (receipt.status === "success") {
      ledger.record("swapExactIn", taker.address, receipt);
      break;
    }
  }

  // Cancel, then settle an epoch.
  await ledger.send(qb, "cancel", { to: cp.vaultB, data: encodeFunctionData({ abi: plumbQuoteAbi, functionName: "cancel" }) as Hex, gas: 100_000n });
  await rpc("evm_increaseTime", [Number(terms.epochLength)]);
  await rpc("evm_mine", []);
  await ledger.send(keeper, "settle", {
    to: deployment.contracts.campaigns,
    data: encodeFunctionData({ abi: plumbCampaignsAbi, functionName: "settle", args: [id] }),
    abi: plumbCampaignsAbi,
  });

  for (const s of ledger.summary()) log.info("gas", { action: s.action, n: s.count, meanGas: s.meanGas });
}

main().catch((err: unknown) => {
  log.error("measure failed", { err: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
