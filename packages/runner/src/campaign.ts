import { decodeEventLog, encodeFunctionData, erc20Abi, parseUnits, zeroAddress, type Address, type PublicClient } from "viem";
import { plumbCampaignsAbi, plumbQuoteAbi, type BotsSchedule } from "@plumbline/shared";
import { CAMPAIGNS, PLUMBUSD, WHYPE } from "./config.js";
import { Signer } from "./chain.js";
import { accountFor, type Env } from "./env.js";
import { funding, plan, type CampaignLite, type Plan } from "./core/campaign.js";
import { errText, type Logger } from "./core/log.js";

/**
 * Campaign manager. Makes sure one v2 campaign on WHYPE/PLUMBUSD has enough time left for the window
 * and that both runner vaults are bonded into it. The sponsor wallet funds the pot, in demo PLUMBUSD.
 * The deployer key is never involved.
 *
 * Every step is attempted once. Anything that fails, or any shortage of PLUMBUSD or HYPE, comes back
 * as `{ ok: false, reason }` and the supervisor halts the run: there is no retry loop here.
 */
export type Outcome = { ok: true; did: string } | { ok: false; reason: string; transient?: boolean };

async function readCampaigns(client: PublicClient, schedule: BotsSchedule): Promise<CampaignLite[]> {
  const count = Number(await client.readContract({ address: CAMPAIGNS, abi: plumbCampaignsAbi, functionName: "campaignCount" }));
  const ids = Array.from({ length: Math.min(count, 6) }, (_, i) => count - i);
  if (ids.length === 0) return [];
  const reads = await client.multicall({
    allowFailure: false,
    contracts: ids.flatMap((id) => [
      { address: CAMPAIGNS, abi: plumbCampaignsAbi, functionName: "terms", args: [BigInt(id)] } as const,
      { address: CAMPAIGNS, abi: plumbCampaignsAbi, functionName: "state", args: [BigInt(id)] } as const,
      { address: CAMPAIGNS, abi: plumbCampaignsAbi, functionName: "vaultsOf", args: [BigInt(id)] } as const,
    ]),
  });
  void schedule;
  return ids.map((id, i) => {
    const t = reads[3 * i] as { base: Address; quote: Address; epochLength: bigint };
    const s = reads[3 * i + 1] as { rewardToken: Address; startTime: bigint; numEpochs: number };
    const v = reads[3 * i + 2] as readonly Address[];
    return { id, base: t.base, quote: t.quote, rewardToken: s.rewardToken, startTime: Number(s.startTime), numEpochs: s.numEpochs, epochLength: Number(t.epochLength), vaults: [...v] };
  });
}

const tokens = { base: WHYPE.address, quote: PLUMBUSD.address, reward: PLUMBUSD.address };

export async function ensureCampaign(
  env: Env,
  schedule: BotsSchedule,
  client: PublicClient,
  sendClient: PublicClient,
  nowSec: number,
  windowEnd: number,
  log: Logger,
): Promise<Outcome> {
  let p: Plan;
  try {
    p = plan(await readCampaigns(client, schedule), schedule, nowSec, windowEnd, tokens);
  } catch (err) {
    return { ok: false, reason: `could not read the campaigns: ${errText(err)}`, transient: true };
  }
  if (p.kind === "ok") return { ok: true, did: "" };

  let sponsor: Signer | null = null;
  let makers: { a: Signer; b: Signer } | null = null;
  try {
    const sp = accountFor(env, "sponsor", schedule);
    const ma = accountFor(env, "makerA", schedule);
    const mb = accountFor(env, "makerB", schedule);
    if (!sp) return { ok: false, reason: "the sponsor wallet is not set up (SPONSOR_KEY)" };
    if (!ma || !mb) return { ok: false, reason: "the maker owner wallets are not set up (MAKER_A_KEY, MAKER_B_KEY)" };
    sponsor = new Signer(sp, [sendClient, client]);
    makers = { a: new Signer(ma, [sendClient, client]), b: new Signer(mb, [sendClient, client]) };
  } catch (err) {
    return { ok: false, reason: errText(err) };
  }

  // Funding first, so a shortage is reported before anything is sent.
  const need = funding(schedule, p);
  const bond = parseUnits(String(schedule.campaign.bondPlumbusd), PLUMBUSD.decimals);
  const bal = async (a: Address) => client.readContract({ address: PLUMBUSD.address, abi: erc20Abi, functionName: "balanceOf", args: [a] });
  const owners = await Promise.all([
    client.readContract({ address: schedule.vaults.a, abi: plumbQuoteAbi, functionName: "owner" }),
    client.readContract({ address: schedule.vaults.b, abi: plumbQuoteAbi, functionName: "owner" }),
  ]).catch(() => null);
  if (!owners) return { ok: false, reason: "could not read the vault owners" };
  if (owners[0].toLowerCase() !== makers.a.address.toLowerCase() || owners[1].toLowerCase() !== makers.b.address.toLowerCase()) {
    return { ok: false, reason: "MAKER_A_KEY / MAKER_B_KEY are not the owners of the vaults in bots.schedule.json" };
  }
  const bonding = p.kind === "open" ? (["a", "b"] as const) : p.vaults;
  const [sponsorBal, aBal, bBal] = await Promise.all([bal(sponsor.address), bal(makers.a.address), bal(makers.b.address)]);
  const makerBal = { a: aBal, b: bBal };
  let topUps = 0n;
  for (const k of bonding) if (makerBal[k] < bond) topUps += bond - makerBal[k];
  if (sponsorBal < need.pot + topUps) {
    const have = Number(sponsorBal) / 10 ** PLUMBUSD.decimals;
    const want = Number(need.pot + topUps) / 10 ** PLUMBUSD.decimals;
    return { ok: false, reason: `the sponsor holds ${have} PLUMBUSD and needs ${want} (pot and bonds)` };
  }

  const GAS = { approve: 100_000n, transfer: 100_000n, open: 700_000n, register: 450_000n };
  try {
    let id = p.kind === "register" ? p.id : 0;
    if (p.kind === "open") {
      await sponsor.sendAndConfirm(PLUMBUSD.address, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [CAMPAIGNS, need.pot] }), GAS.approve);
      const c = schedule.campaign;
      const terms = {
        base: WHYPE.address,
        quote: PLUMBUSD.address,
        epochLength: BigInt(c.epochLengthSeconds),
        rewardPerEpoch: parseUnits(String(c.rewardPerEpochPlumbusd), PLUMBUSD.decimals),
        maxSpreadBps: c.maxSpreadBps,
        minDepthBase: parseUnits(c.minDepthBase, WHYPE.decimals),
        minDepthQuote: parseUnits(c.minDepthQuote, PLUMBUSD.decimals),
        minProbeInterval: c.minProbeIntervalSeconds,
        probeFeeBps: c.probeFeeBps,
        makerBond: bond,
      } as const;
      const receipt = await sponsor.sendAndConfirm(
        CAMPAIGNS,
        encodeFunctionData({ abi: plumbCampaignsAbi, functionName: "openCampaign", args: [terms, PLUMBUSD.address, p.epochs, 0n, zeroAddress] }),
        GAS.open,
      );
      for (const l of receipt.logs) {
        try {
          const e = decodeEventLog({ abi: plumbCampaignsAbi, data: l.data, topics: l.topics });
          if (e.eventName === "CampaignOpened") id = Number(e.args.id);
        } catch {
          // another contract's log
        }
      }
      if (!id) return { ok: false, reason: "the campaign opened but its id was not in the receipt" };
      log.info("campaign opened", { id, epochs: p.epochs });
    }
    for (const k of bonding) {
      const owner = k === "a" ? makers.a : makers.b;
      if (makerBal[k] < bond) {
        await sponsor.sendAndConfirm(PLUMBUSD.address, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [owner.address, bond - makerBal[k]] }), GAS.transfer);
      }
      await owner.sendAndConfirm(PLUMBUSD.address, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [CAMPAIGNS, bond] }), GAS.approve);
      await owner.sendAndConfirm(
        CAMPAIGNS,
        encodeFunctionData({ abi: plumbCampaignsAbi, functionName: "register", args: [BigInt(id), k === "a" ? schedule.vaults.a : schedule.vaults.b] }),
        GAS.register,
      );
      log.info("vault bonded", { id, vault: k });
    }
    return { ok: true, did: p.kind === "open" ? `opened campaign ${id}` : `bonded into campaign ${id}` };
  } catch (err) {
    return { ok: false, reason: `a campaign step failed: ${errText(err)}` };
  }
}
