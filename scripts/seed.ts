/**
 * Seed the demo.
 *
 *   pnpm seed
 *
 * 1. Deploys PLUMBUSD (DemoQuoteToken), a mintable stand-in for USDC, because canonical USDC is not
 *    faucet-available on Elysium testnet. Its address is added to packages/shared as a demo token.
 * 2. Registers the canonical WHYPE/USDC market on-chain (one empty vault) and leaves it unseeded.
 * 3. Seeds WHYPE/PLUMBUSD: two maker vaults quoted by separate hot keys, a small WHYPE ask side,
 *    a minted PLUMBUSD bid side, and a campaign whose pot and bonds are in PLUMBUSD. Native HYPE
 *    is spent only on gas and the WHYPE inventory.
 *
 * Every amount comes from SEED_* env vars, written by `pnpm budget` from measured gas. Progress is
 * checkpointed in data/seed-<chainId>.json so re-running resumes. Every transaction lands in the
 * gas ledger data/gas-<chainId>-<SEED_LEDGER_TAG>.json.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createPublicClient,
  decodeEventLog,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  formatEther,
  formatUnits,
  getAddress,
  http,
  parseEther,
  parseUnits,
  zeroAddress,
  type Abi,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  deployment,
  elysiumTestnet,
  plumbCampaignsAbi,
  plumbQuoteFactoryAbi,
  wrappedNativeAbi,
} from "@plumbline/shared";
import { TxSender, makeLogger, throttleRpc } from "@plumbline/shared/node";
import { loadEnv, hexKey, ROOT } from "./lib/env.js";
import { forge, CONTRACTS_DIR } from "./lib/forge.js";
import { verifyOne, verifyVault } from "./lib/verify.js";
import { updateReadme } from "./lib/readme.js";
import { writeAddresses, type DeploymentRecord } from "./lib/addresses.js";
import { Ledger } from "./lib/ledger.js";
import { writeEnv } from "./lib/envfile.js";

loadEnv();
const log = makeLogger("seed");
const rpcUrl = process.env.ELYSIUM_RPC_URL ?? "https://testnet-rpc.elysium.kinetiq.xyz";
throttleRpc([rpcUrl], Number(process.env.SEED_RPC_PER_SECOND ?? 1.5), (m) => log.warn(m));
const env = (k: string, d: string) => process.env[k] || d;

const S = {
  makerHype: parseEther(env("SEED_MAKER_HYPE", "0.0004")),
  quoterHype: parseEther(env("SEED_QUOTER_HYPE", "0.005")),
  keeperHype: parseEther(env("SEED_KEEPER_HYPE", "0.005")),
  vaultWhype: env("SEED_VAULT_WHYPE", "0.002"),
  vaultQuote: env("SEED_VAULT_QUOTE", "500"),
  rewardPerEpoch: env("SEED_REWARD_PER_EPOCH", "100"),
  epochs: Number(env("SEED_EPOCHS", "12")),
  epochLength: BigInt(env("SEED_EPOCH_LENGTH", "600")),
  bond: env("SEED_BOND", "25"),
  maxSpreadBps: Number(env("SEED_MAX_SPREAD_BPS", "30")),
  minDepthBase: env("SEED_MIN_DEPTH_BASE", "0.0005"),
  minDepthQuote: env("SEED_MIN_DEPTH_QUOTE", "0.02"),
  minProbeInterval: Number(env("SEED_MIN_PROBE_INTERVAL", "15")),
  probeFeeBps: Number(env("SEED_PROBE_FEE_BPS", "10")),
  registerCanonical: env("SEED_REGISTER_CANONICAL", "true") === "true",
};

interface Checkpoint {
  demoToken?: `0x${string}`;
  vaultA?: `0x${string}`;
  vaultB?: `0x${string}`;
  canonicalVault?: `0x${string}`;
  campaignId?: number;
  minted?: boolean;
  wrapped?: boolean;
  funded?: { a: boolean; b: boolean };
  registered?: { a: boolean; b: boolean };
  gasSent?: boolean;
}

const cpPath = join(ROOT, "data", `seed-${deployment.chainId}.json`);
const loadCp = (): Checkpoint => (existsSync(cpPath) ? (JSON.parse(readFileSync(cpPath, "utf8")) as Checkpoint) : {});
function saveCp(cp: Checkpoint): void {
  mkdirSync(join(ROOT, "data"), { recursive: true });
  writeFileSync(cpPath, JSON.stringify(cp, null, 2));
}

function eventArg<T>(receipt: TransactionReceipt, abi: Abi, name: string, arg: string): T | null {
  for (const l of receipt.logs) {
    try {
      const e = decodeEventLog({ abi, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
      if (e.eventName === name) return (e.args as unknown as Record<string, unknown>)[arg] as T;
    } catch {
      // another contract's log
    }
  }
  return null;
}

async function main(): Promise<void> {
  if (!deployment.deployed) throw new Error("deploy first: pnpm contracts:deploy");
  const client = createPublicClient({ chain: elysiumTestnet, transport: http(rpcUrl, { retryCount: 3 }), pollingInterval: 100 });
  const chainId = await client.getChainId();
  const ledger = Ledger.forRun(chainId, env("SEED_LEDGER_TAG", "live"));
  const mk = (name: string) => new TxSender(privateKeyToAccount(hexKey(name)), client, chainId, log);
  const deployer = mk("DEPLOYER_PRIVATE_KEY");
  const makerA = mk("MAKER_A_PRIVATE_KEY");
  const makerB = mk("MAKER_B_PRIVATE_KEY");
  const quoterA = privateKeyToAccount(hexKey("QUOTER_A_PRIVATE_KEY")).address;
  const quoterB = privateKeyToAccount(hexKey("QUOTER_B_PRIVATE_KEY")).address;
  const keeper = privateKeyToAccount(hexKey("KEEPER_PRIVATE_KEY")).address;
  const WHYPE = deployment.tokens.WHYPE;
  const USDC = deployment.tokens.USDC;
  const { factory, campaigns } = deployment.contracts;
  const cp = loadCp();
  // --new-campaign: keep the vaults and inventory, open another campaign and bond them into it.
  const newCampaign = process.argv.includes("--new-campaign");
  if (newCampaign) {
    if (!cp.vaultA || !cp.vaultB || !cp.demoToken) throw new Error("--new-campaign needs a completed seed");
    delete cp.campaignId;
    delete cp.registered;
  }

  const startBalance = await client.getBalance({ address: deployer.address });
  log.info("deployer", { address: deployer.address, hype: formatEther(startBalance) });

  // 1. PLUMBUSD.
  if (!cp.demoToken) {
    forge(["build"]);
    const artifact = JSON.parse(
      readFileSync(join(CONTRACTS_DIR, "out", "DemoQuoteToken.sol", "DemoQuoteToken.json"), "utf8"),
    ) as { bytecode: { object: Hex } };
    const ctor = encodeAbiParameters([{ type: "address" }], [deployer.address]);
    const { receipt } = await ledger.send(deployer, "deploy DemoQuoteToken", {
      data: (artifact.bytecode.object + ctor.slice(2)) as Hex,
    });
    if (!receipt.contractAddress) throw new Error("DemoQuoteToken deploy returned no address");
    cp.demoToken = getAddress(receipt.contractAddress);
    saveCp(cp);
    log.info("PLUMBUSD deployed", { address: cp.demoToken });
  }
  const demo = { address: cp.demoToken, symbol: "PLUMBUSD", name: "Plumbline Demo Dollar", decimals: 6 };
  const record = { ...(deployment as unknown as DeploymentRecord), demoTokens: { PLUMBUSD: demo } };
  writeAddresses(record);
  const Q = demo;

  const vaultWhype = parseUnits(S.vaultWhype, WHYPE.decimals);
  const vaultQuote = parseUnits(S.vaultQuote, Q.decimals);
  const rewardPerEpoch = parseUnits(S.rewardPerEpoch, Q.decimals);
  const bond = parseUnits(S.bond, Q.decimals);
  const pot = rewardPerEpoch * BigInt(S.epochs);

  // 2. Gas for every other wallet, sized by `pnpm budget`.
  if (!cp.gasSent) {
    const sends: [string, `0x${string}`, bigint][] = [
      ["maker A", makerA.address, S.makerHype],
      ["maker B", makerB.address, S.makerHype],
      ["quoter A", quoterA, S.quoterHype],
      ["quoter B", quoterB, S.quoterHype],
      ["keeper", keeper, S.keeperHype],
    ];
    for (const [who, to, value] of sends) {
      const bal = await client.getBalance({ address: to });
      if (bal >= value) continue;
      await ledger.send(deployer, "transfer HYPE", { to, data: "0x", value: value - bal, gas: 30_000n });
      log.info("funded", { who, hype: formatEther(value - bal) });
    }
    cp.gasSent = true;
    saveCp(cp);
  }

  // 3. Vaults.
  const createVault = async (owner: TxSender, quote: `0x${string}`, quoter: `0x${string}`) => {
    const { receipt } = await ledger.send(owner, "createVault", {
      to: factory,
      data: encodeFunctionData({ abi: plumbQuoteFactoryAbi, functionName: "createVault", args: [WHYPE.address, quote, quoter] }),
    });
    const vault = eventArg<`0x${string}`>(receipt, plumbQuoteFactoryAbi, "VaultCreated", "vault");
    if (!vault) throw new Error("VaultCreated not found");
    return vault;
  };
  if (S.registerCanonical && !cp.canonicalVault) {
    // Registers the canonical WHYPE/USDC market on-chain. Left unfunded: ready for real USDC.
    cp.canonicalVault = await createVault(deployer, USDC.address, zeroAddress);
    saveCp(cp);
    log.info("WHYPE/USDC market registered (unseeded)", { vault: cp.canonicalVault });
  }
  if (!cp.vaultA) {
    cp.vaultA = await createVault(makerA, Q.address, quoterA);
    saveCp(cp);
  }
  if (!cp.vaultB) {
    cp.vaultB = await createVault(makerB, Q.address, quoterB);
    saveCp(cp);
  }
  log.info("maker vaults", { a: cp.vaultA, b: cp.vaultB });
  writeEnv({
    MAKER_A_VAULT: cp.vaultA,
    MAKER_B_VAULT: cp.vaultB,
    MAKER_A_PAIR: "WHYPE-PLUMBUSD",
    MAKER_B_PAIR: "WHYPE-PLUMBUSD",
  });

  // 4. PLUMBUSD: bid inventory for both vaults, the pot, and both bonds. Gas only.
  if (!cp.minted) {
    const mint = (to: `0x${string}`, amount: bigint) =>
      ledger.send(deployer, "mint PLUMBUSD", {
        to: Q.address,
        data: encodeFunctionData({
          abi: [{ type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] }] as const,
          functionName: "mint",
          args: [to, amount],
        }),
      });
    await mint(cp.vaultA, vaultQuote);
    await mint(cp.vaultB, vaultQuote);
    await mint(deployer.address, pot);
    await mint(makerA.address, bond);
    await mint(makerB.address, bond);
    cp.minted = true;
    saveCp(cp);
    log.info("minted PLUMBUSD", { perVault: S.vaultQuote, pot: formatUnits(pot, Q.decimals), bond: S.bond });
  }

  // 5. WHYPE ask side: wrap exactly what two vaults need.
  if (!cp.wrapped) {
    await ledger.send(deployer, "wrap HYPE", {
      to: WHYPE.address,
      data: encodeFunctionData({ abi: wrappedNativeAbi, functionName: "deposit" }),
      value: vaultWhype * 2n,
    });
    cp.wrapped = true;
    saveCp(cp);
  }
  cp.funded ??= { a: false, b: false };
  for (const [key, vault] of [["a", cp.vaultA], ["b", cp.vaultB]] as const) {
    if (cp.funded[key]) continue;
    await ledger.send(deployer, "transfer WHYPE", {
      to: WHYPE.address,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [vault, vaultWhype] }),
    });
    cp.funded[key] = true;
    saveCp(cp);
  }
  log.info("inventory", { whypePerVault: S.vaultWhype, plumbusdPerVault: S.vaultQuote });

  // 6. Campaign, pot and bonds in PLUMBUSD.
  if (!cp.campaignId && newCampaign) {
    for (const [to, amount] of [[deployer.address, pot], [makerA.address, bond], [makerB.address, bond]] as const) {
      await ledger.send(deployer, "mint PLUMBUSD", {
        to: Q.address,
        data: encodeFunctionData({
          abi: [{ type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] }] as const,
          functionName: "mint",
          args: [to, amount],
        }),
      });
    }
  }
  if (!cp.campaignId) {
    await ledger.send(deployer, "approve", {
      to: Q.address,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [campaigns, pot] }),
    });
    const terms = {
      base: WHYPE.address,
      quote: Q.address,
      epochLength: S.epochLength,
      rewardPerEpoch,
      maxSpreadBps: S.maxSpreadBps,
      minDepthBase: parseUnits(S.minDepthBase, WHYPE.decimals),
      minDepthQuote: parseUnits(S.minDepthQuote, Q.decimals),
      minProbeInterval: S.minProbeInterval,
      probeFeeBps: S.probeFeeBps,
      makerBond: bond,
    } as const;
    const { receipt } = await ledger.send(deployer, "openCampaign", {
      to: campaigns,
      data: encodeFunctionData({ abi: plumbCampaignsAbi, functionName: "openCampaign", args: [terms, Q.address, S.epochs, 0n, zeroAddress] }),
      abi: plumbCampaignsAbi,
    });
    const id = eventArg<bigint>(receipt, plumbCampaignsAbi, "CampaignOpened", "id");
    if (id === null) throw new Error("CampaignOpened not found");
    cp.campaignId = Number(id);
    saveCp(cp);
    log.info("campaign opened", { id: cp.campaignId, pot: `${formatUnits(pot, Q.decimals)} PLUMBUSD`, epochs: S.epochs });
  }

  cp.registered ??= { a: false, b: false };
  for (const [key, maker, vault] of [["a", makerA, cp.vaultA], ["b", makerB, cp.vaultB]] as const) {
    if (cp.registered[key]) continue;
    await ledger.send(maker, "approve", {
      to: Q.address,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [campaigns, bond] }),
    });
    await ledger.send(maker, "register + bond", {
      to: campaigns,
      data: encodeFunctionData({ abi: plumbCampaignsAbi, functionName: "register", args: [BigInt(cp.campaignId), vault] }),
      abi: plumbCampaignsAbi,
    });
    cp.registered[key] = true;
    saveCp(cp);
    log.info("bonded", { vault, bond: `${S.bond} PLUMBUSD` });
  }
  writeEnv({ KEEPER_CAMPAIGNS: String(cp.campaignId) });

  if (process.argv.includes("--verify")) {
    const ctor = encodeAbiParameters([{ type: "address" }], [deployer.address]);
    verifyOne(cp.demoToken, "src/test/DemoQuoteToken.sol:DemoQuoteToken", ctor);
    const { maxAge, withdrawDelay } = deployment.params;
    verifyVault(cp.vaultA, makerA.address, quoterA, WHYPE.address, Q.address, maxAge, withdrawDelay);
    verifyVault(cp.vaultB, makerB.address, quoterB, WHYPE.address, Q.address, maxAge, withdrawDelay);
    if (cp.canonicalVault) verifyVault(cp.canonicalVault, deployer.address, zeroAddress, WHYPE.address, USDC.address, maxAge, withdrawDelay);
  }

  updateReadme(record);
  const end = await client.getBalance({ address: deployer.address });
  log.info("seed complete", {
    campaign: cp.campaignId,
    deployerSpent: formatEther(startBalance - end),
    deployerLeft: formatEther(end),
  });
}

main().catch((err: unknown) => {
  log.error("seed failed", { err: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
