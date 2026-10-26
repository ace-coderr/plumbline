/**
 * Deploy the PLUMBUSD faucet, fund it, verify its source, and record it in the shared addresses and
 * the README table.
 *
 *   pnpm deploy:faucet                  fork dry-run only: simulates, prices the gas with 30% headroom,
 *                                       checks the deployer's balance, deploys nothing
 *   pnpm deploy:faucet --broadcast      dry-run first; deploys only if it passed and the balance covers it
 *   pnpm deploy:faucet --broadcast --no-verify
 *
 * Never deploys after a failed dry-run, and stops (exit 2) with the exact shortfall if the deployer
 * cannot cover the gas plus headroom.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, encodeAbiParameters, formatEther, getAddress, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { deployment } from "@plumbline/shared";
import { loadEnv, hexKey, ROOT } from "./lib/env.js";
import { forge, forgeCapture, CONTRACTS_DIR } from "./lib/forge.js";
import { writeAddresses, type DeploymentRecord } from "./lib/addresses.js";
import { verifyOne } from "./lib/verify.js";
import { updateReadme } from "./lib/readme.js";

loadEnv();
const CHAIN_ID = 99801;
const HEADROOM = 1.3;
const rpcUrl = process.env.ELYSIUM_RPC_URL ?? "https://testnet-rpc.elysium.kinetiq.xyz";
const args = new Set(process.argv.slice(2));

const AMOUNT = 100n * 10n ** 6n; // 100 PLUMBUSD
const COOLDOWN = 24 * 60 * 60;
const FUND = 10_000n * 10n ** 6n; // 10,000 PLUMBUSD

async function main(): Promise<void> {
  const client = createPublicClient({ transport: http(rpcUrl) });
  if ((await client.getChainId()) !== CHAIN_ID) throw new Error(`RPC is not chain ${CHAIN_ID}`);
  const demo = (deployment.demoTokens as Record<string, { address: string }>).PLUMBUSD;
  if (!demo) throw new Error("no PLUMBUSD in the deployment record");
  const token = getAddress(demo.address);
  const key = hexKey("DEPLOYER_PRIVATE_KEY");
  const deployer = privateKeyToAccount(key).address;
  const env = {
    DEPLOYER_PRIVATE_KEY: key,
    FAUCET_TOKEN: token,
    FAUCET_AMOUNT: AMOUNT.toString(),
    FAUCET_COOLDOWN: String(COOLDOWN),
    FAUCET_FUND: FUND.toString(),
  };

  forge(["build"]);
  console.log("\n== fork dry-run (nothing is sent)");
  const out = forgeCapture(["script", "script/DeployFaucet.s.sol:DeployFaucet", "--rpc-url", rpcUrl, "-vv"], env);
  process.stdout.write(out.split("\n").filter((l) => /faucet|pool|Estimated|Script ran/i.test(l)).join("\n") + "\n");
  const gas = /Estimated total gas used for script: (\d+)/.exec(out);
  if (!gas) throw new Error("dry-run did not report gas; refusing to deploy");
  if (!/Script ran successfully/.test(out)) throw new Error("dry-run failed; refusing to deploy");

  const gasUnits = BigInt(gas[1] as string);
  const gasPrice = await client.getGasPrice();
  const cost = gasUnits * gasPrice;
  const needed = (cost * BigInt(Math.round(HEADROOM * 100))) / 100n;
  const balance = await client.getBalance({ address: deployer });
  console.log(`\n== gas budget`);
  console.log(`  deploy + fund:  ${gasUnits} gas x ${gasPrice} wei = ${formatEther(cost)} HYPE`);
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
  forge(["script", "script/DeployFaucet.s.sol:DeployFaucet", "--rpc-url", rpcUrl, "--broadcast", "--slow", "-vv"], env);
  const run = JSON.parse(readFileSync(join(CONTRACTS_DIR, "broadcast", "DeployFaucet.s.sol", String(CHAIN_ID), "run-latest.json"), "utf8")) as {
    transactions: { contractName: string; contractAddress: string }[];
    receipts: { blockNumber: Hex; gasUsed: Hex; effectiveGasPrice: Hex }[];
  };
  const created = run.transactions.find((t) => t.contractName === "PlumbFaucet");
  if (!created) throw new Error("broadcast has no PlumbFaucet creation");
  const address = getAddress(created.contractAddress);
  const spent = run.receipts.reduce((a, r) => a + BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice), 0n);
  const block = Math.min(...run.receipts.map((r) => Number(BigInt(r.blockNumber))));
  const code = await client.getCode({ address });
  if (!code || code === "0x") throw new Error(`no code at ${address}`);
  const blk = await client.getBlock({ blockNumber: BigInt(block) });
  console.log(`  faucet ${address} at block ${block}; spent ${formatEther(spent)} HYPE`);

  if (!args.has("--no-verify")) {
    verifyOne(
      address,
      "src/test/PlumbFaucet.sol:PlumbFaucet",
      encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint256" }], [token, AMOUNT, BigInt(COOLDOWN)]),
    );
  }
  const record: DeploymentRecord = {
    ...(deployment as unknown as DeploymentRecord),
    faucet: { address, token, amount: AMOUNT.toString(), cooldown: COOLDOWN, deployBlock: block, deployedAt: new Date(Number(blk.timestamp) * 1000).toISOString() },
  };
  writeAddresses(record);
  updateReadme(record);
  console.log(`  recorded in packages/shared/src/addresses.ts and the README (${ROOT.length} char root)`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
