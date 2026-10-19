/**
 * Deploy Plumbline to Elysium testnet and generate packages/shared/src/addresses.ts.
 *
 *   pnpm contracts:deploy            build, deploy, verify on the explorer, write addresses
 *   pnpm contracts:deploy --no-verify
 *   pnpm contracts:deploy --addresses-only   rewrite addresses.ts from the last deployment record
 *   pnpm contracts:deploy --placeholder      write an undeployed addresses.ts (tokens only) so packages build
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, getAddress, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadEnv, hexKey, ROOT } from "./lib/env.js";
import { forge, CONTRACTS_DIR } from "./lib/forge.js";
import { readCanonicalTokens } from "./lib/tokens.js";
import { writeAddresses, ADDRESSES_PATH, type DeploymentRecord } from "./lib/addresses.js";
import { verifyCore } from "./lib/verify.js";
import { updateReadme } from "./lib/readme.js";

loadEnv();

const CHAIN_ID = 99801;
const rpcUrl = process.env.ELYSIUM_RPC_URL ?? "https://testnet-rpc.elysium.kinetiq.xyz";
const args = new Set(process.argv.slice(2));

interface ForgeDeploymentJson {
  chainId: number;
  deployer: string;
  factory: string;
  campaigns: string;
  router: string;
  maxAge: number;
  withdrawDelay: number;
}

interface BroadcastRun {
  receipts: { blockNumber: Hex; contractAddress: string | null }[];
}

async function main(): Promise<void> {
  const client = createPublicClient({ transport: http(rpcUrl) });
  const chainId = await client.getChainId();
  if (chainId !== CHAIN_ID) throw new Error(`RPC reports chain ${chainId}, expected ${CHAIN_ID}`);

  console.log("checking canonical tokens on-chain");
  const tokens = await readCanonicalTokens(client);
  for (const t of Object.values(tokens)) console.log(`  ${t.symbol.padEnd(6)} ${t.address} decimals=${t.decimals}`);

  if (args.has("--placeholder")) {
    const zero = "0x0000000000000000000000000000000000000000" as const;
    writeAddresses({
      chainId: CHAIN_ID,
      deployed: false,
      deployBlock: 0,
      deployedAt: "",
      deployer: zero,
      contracts: { factory: zero, router: zero, campaigns: zero },
      params: { maxAge: 2, withdrawDelay: 30 },
      tokens,
      demoTokens: {},
    });
    console.log("wrote placeholder addresses.ts");
    return;
  }

  if (!args.has("--addresses-only")) {
    const key = hexKey("DEPLOYER_PRIVATE_KEY");
    const deployer = privateKeyToAccount(key).address;
    const balance = await client.getBalance({ address: deployer });
    console.log(`deployer ${deployer} balance ${balance} wei`);
    if (balance === 0n) throw new Error("deployer has no HYPE; fund it from the faucet first");

    forge(["build"]);
    forge(
      ["script", "script/Deploy.s.sol:Deploy", "--rpc-url", rpcUrl, "--broadcast", "--slow", "-vv"],
      { DEPLOYER_PRIVATE_KEY: key },
    );
  }

  const recordPath = join(CONTRACTS_DIR, "deployments", `${CHAIN_ID}.json`);
  if (!existsSync(recordPath)) throw new Error(`no deployment record at ${recordPath}`);
  const rec = JSON.parse(readFileSync(recordPath, "utf8")) as ForgeDeploymentJson;

  const broadcastPath = join(CONTRACTS_DIR, "broadcast", "Deploy.s.sol", String(CHAIN_ID), "run-latest.json");
  const run = JSON.parse(readFileSync(broadcastPath, "utf8")) as BroadcastRun;
  const deployBlock = Math.min(...run.receipts.map((r) => Number(BigInt(r.blockNumber))));
  const block = await client.getBlock({ blockNumber: BigInt(deployBlock) });

  const record: DeploymentRecord = {
    chainId: CHAIN_ID,
    deployed: true,
    deployBlock,
    deployedAt: new Date(Number(block.timestamp) * 1000).toISOString(),
    deployer: getAddress(rec.deployer),
    contracts: {
      factory: getAddress(rec.factory),
      router: getAddress(rec.router),
      campaigns: getAddress(rec.campaigns),
    },
    params: { maxAge: Number(rec.maxAge), withdrawDelay: Number(rec.withdrawDelay) },
    tokens,
    // A fresh deployment starts without demo tokens; the seed adds them.
    demoTokens: {},
  };

  for (const [name, addr] of Object.entries(record.contracts)) {
    const code = await client.getCode({ address: addr });
    if (!code || code === "0x") throw new Error(`${name} at ${addr} has no code`);
  }

  writeAddresses(record);
  updateReadme(record);
  console.log(`wrote ${ADDRESSES_PATH.replace(ROOT, ".")} (deploy block ${deployBlock}) and the README table`);

  if (!args.has("--no-verify") && !args.has("--addresses-only")) {
    verifyCore(record);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
