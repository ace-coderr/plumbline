/**
 * Redeploy PlumbCampaigns and PlumbRouter (the two contracts that bind each other) against the existing
 * factory, so the probe gate counts Orbit L2 blocks through ArbSys. The factory and its vaults bind
 * neither contract and are not touched.
 *
 *   pnpm deploy:v2                      fork dry-run only: simulates, prices the gas with 30% headroom,
 *                                       checks the deployer's balance, deploys nothing
 *   pnpm deploy:v2 --broadcast          dry-run first; deploys only if it passed and the balance covers it
 *   pnpm deploy:v2 --broadcast --no-verify
 *
 * The old pair is kept in the deployment record as `legacy` (v1). Never deploys after a failed dry-run,
 * and stops (exit 2) with the exact shortfall if the deployer cannot cover the gas plus headroom.
 * Tagging the deployed commit (`deployed-<chain>-v2-<date>`) is printed as the last step, not done here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, encodeAbiParameters, formatEther, getAddress, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { deployment } from "@plumbline/shared";
import { loadEnv, hexKey } from "./lib/env.js";
import { forge, forgeCapture, CONTRACTS_DIR } from "./lib/forge.js";
import { writeAddresses, type DeploymentRecord } from "./lib/addresses.js";
import { verifyOne } from "./lib/verify.js";
import { sourceTag, updateReadme } from "./lib/readme.js";

loadEnv();
const CHAIN_ID = 99801;
const HEADROOM = 1.3;
const rpcUrl = process.env.ELYSIUM_RPC_URL ?? "https://testnet-rpc.elysium.kinetiq.xyz";
const args = new Set(process.argv.slice(2));

async function main(): Promise<void> {
  const record = deployment as unknown as DeploymentRecord;
  if (record.legacy) throw new Error("the deployment record already has a legacy (v1) pair: v2 is already deployed");
  const client = createPublicClient({ transport: http(rpcUrl) });
  if ((await client.getChainId()) !== CHAIN_ID) throw new Error(`RPC is not chain ${CHAIN_ID}`);
  const key = hexKey("DEPLOYER_PRIVATE_KEY");
  const deployer = privateKeyToAccount(key).address;
  const env = { DEPLOYER_PRIVATE_KEY: key, FACTORY: record.contracts.factory };

  forge(["build"]);
  console.log("\n== fork dry-run (nothing is sent)");
  const out = forgeCapture(["script", "script/DeployCampaignsV2.s.sol:DeployCampaignsV2", "--rpc-url", rpcUrl, "-vv"], env);
  process.stdout.write(out.split("\n").filter((l) => /campaigns|router|Estimated|Script ran/i.test(l)).join("\n") + "\n");
  const gas = /Estimated total gas used for script: (\d+)/.exec(out);
  if (!gas) throw new Error("dry-run did not report gas; refusing to deploy");
  if (!/Script ran successfully/.test(out)) throw new Error("dry-run failed; refusing to deploy");

  const gasUnits = BigInt(gas[1] as string);
  const gasPrice = await client.getGasPrice();
  const cost = gasUnits * gasPrice;
  const needed = (cost * BigInt(Math.round(HEADROOM * 100))) / 100n;
  const balance = await client.getBalance({ address: deployer });
  console.log(`\n== gas budget`);
  console.log(`  campaigns + router:  ${gasUnits} gas x ${gasPrice} wei = ${formatEther(cost)} HYPE`);
  console.log(`  with 30% headroom: ${formatEther(needed)} HYPE`);
  console.log(`  deployer ${deployer}: ${formatEther(balance)} HYPE`);
  if (balance < needed) {
    console.log(`\nSTOP: short by ${formatEther(needed - balance)} HYPE. Nothing was deployed.`);
    process.exit(2);
  }
  console.log(`  OK: balance covers it, leaving ${formatEther(balance - needed)} HYPE`);
  if (!args.has("--broadcast")) {
    console.log("\ndry-run only; pass --broadcast to deploy");
    return;
  }

  console.log("\n== deploying");
  forge(["script", "script/DeployCampaignsV2.s.sol:DeployCampaignsV2", "--rpc-url", rpcUrl, "--broadcast", "--slow", "-vv"], env);
  const run = JSON.parse(
    readFileSync(join(CONTRACTS_DIR, "broadcast", "DeployCampaignsV2.s.sol", String(CHAIN_ID), "run-latest.json"), "utf8"),
  ) as {
    transactions: { contractName: string; contractAddress: string }[];
    receipts: { blockNumber: Hex; gasUsed: Hex; effectiveGasPrice: Hex }[];
  };
  const find = (name: string) => {
    const t = run.transactions.find((x) => x.contractName === name);
    if (!t) throw new Error(`broadcast has no ${name} creation`);
    return getAddress(t.contractAddress);
  };
  const campaigns = find("PlumbCampaigns");
  const router = find("PlumbRouter");
  const spent = run.receipts.reduce((a, r) => a + BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice), 0n);
  const block = Math.min(...run.receipts.map((r) => Number(BigInt(r.blockNumber))));
  for (const a of [campaigns, router]) {
    const code = await client.getCode({ address: a });
    if (!code || code === "0x") throw new Error(`no code at ${a}`);
  }
  const blk = await client.getBlock({ blockNumber: BigInt(block) });
  const deployedAt = new Date(Number(blk.timestamp) * 1000).toISOString();
  console.log(`  campaigns ${campaigns}\n  router    ${router}\n  block ${block}; spent ${formatEther(spent)} HYPE`);

  if (!args.has("--no-verify")) {
    const factory = record.contracts.factory;
    verifyOne(campaigns, "src/PlumbCampaigns.sol:PlumbCampaigns", encodeAbiParameters([{ type: "address" }, { type: "address" }], [factory, router]));
    verifyOne(router, "src/PlumbRouter.sol:PlumbRouter", encodeAbiParameters([{ type: "address" }, { type: "address" }], [factory, campaigns]));
  }

  const v2Tag = `deployed-${CHAIN_ID}-v2-${deployedAt.slice(0, 10)}`;
  const next: DeploymentRecord = {
    ...record,
    contracts: { factory: record.contracts.factory, router, campaigns },
    legacy: {
      campaigns: record.contracts.campaigns,
      router: record.contracts.router,
      deployBlock: record.deployBlock,
      deployedAt: record.deployedAt,
      sourceTag: sourceTag(record),
    },
    v2: { deployBlock: block, deployedAt, sourceTag: v2Tag },
  };
  writeAddresses(next);
  updateReadme(next);
  console.log(`\n  recorded in packages/shared/src/addresses.ts and the README`);
  console.log(`  next: commit, then tag the deployed commit:  git tag ${v2Tag} && git push origin ${v2Tag}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
