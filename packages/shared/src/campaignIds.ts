import { deployment } from "./addresses.js";
import type { Address } from "./pairs.js";

/**
 * Plumbline has had two campaigns contracts: v1 (legacy, whose probe gate counted the parent chain's
 * blocks) and v2 (counts Orbit L2 blocks). Both number their campaigns from 1, so inside the app a
 * campaign has one id that cannot collide: v1 campaigns keep their own number, v2 campaigns are
 * `V2_ID_BASE + number`. Everything keyed by campaign (snapshot rows, live reads, scorecards, URLs)
 * uses this id, and only a contract call turns it back into (contract, number) with `resolveCampaign`.
 *
 * A deployment without a legacy pair (a fresh local stack) has one contract and plain ids.
 */
export const V2_ID_BASE = 1_000_000;

export interface CampaignSource {
  /** "v1" is the legacy contract, "v2" the current one after a redeploy, "current" the only one otherwise. */
  version: "v1" | "v2" | "current";
  campaigns: Address;
  router: Address;
  /** Added to the contract's own campaign number to get the app id. */
  idBase: number;
  /** The contract's own deploy block, or the deployment's when it is the only one. */
  deployBlock: number;
}

interface LegacyRecord {
  campaigns: Address;
  router: Address;
  deployBlock: number;
}
interface V2Record {
  deployBlock: number;
}
const record = deployment as unknown as { deployBlock: number; contracts: { campaigns: Address; router: Address }; legacy?: LegacyRecord; v2?: V2Record };

/** Every campaigns contract the app reads, oldest first. */
export const campaignSources: CampaignSource[] = record.legacy
  ? [
      { version: "v1", campaigns: record.legacy.campaigns, router: record.legacy.router, idBase: 0, deployBlock: record.legacy.deployBlock },
      { version: "v2", campaigns: record.contracts.campaigns, router: record.contracts.router, idBase: V2_ID_BASE, deployBlock: record.v2?.deployBlock ?? record.deployBlock },
    ]
  : [{ version: "current", campaigns: record.contracts.campaigns, router: record.contracts.router, idBase: 0, deployBlock: record.deployBlock }];

/** The contract new campaigns open on. */
export const currentSource: CampaignSource = campaignSources[campaignSources.length - 1] as CampaignSource;

/** Whether there is a legacy contract, so labels and links need the version. */
export const hasLegacy = campaignSources.length > 1;

const lc = (a: string) => a.toLowerCase();

/** The source an app id belongs to. */
export function sourceOfId(appId: number): CampaignSource {
  return hasLegacy && appId >= V2_ID_BASE ? currentSource : (campaignSources[0] as CampaignSource);
}

/** The source whose contract is `address`, if it is one of ours. */
export function sourceOfAddress(address: string): CampaignSource | null {
  return campaignSources.find((s) => lc(s.campaigns) === lc(address)) ?? null;
}

/** The contract and its own campaign number for an app id: what a transaction or a call needs. */
export function resolveCampaign(appId: number): { source: CampaignSource; localId: number } {
  const source = sourceOfId(appId);
  return { source, localId: appId - source.idBase };
}

/** The app id for campaign number `localId` on the contract at `address`; null for an unknown contract. */
export function appIdOf(address: string, localId: number): number | null {
  const s = sourceOfAddress(address);
  return s ? s.idBase + localId : null;
}

/** "#3" with one contract; "v1 #3" or "v2 #1" when there are two. */
export function campaignLabel(appId: number | string): string {
  const id = Number(appId);
  if (!hasLegacy) return `#${id}`;
  const { source, localId } = resolveCampaign(id);
  return `${source.version} #${localId}`;
}

/** The page for a campaign: `/campaign/3` for v1 and a single contract, `/campaign/v2-1` for v2. */
export function campaignPath(appId: number | string): string {
  const id = Number(appId);
  if (!hasLegacy) return `/campaign/${id}`;
  const { source, localId } = resolveCampaign(id);
  return source.version === "v2" ? `/campaign/v2-${localId}` : `/campaign/${localId}`;
}

/** The app id for a `/campaign/:id` URL parameter ("3" or "v2-1"), or null if it is not a campaign number. */
export function parseCampaignParam(param: string): number | null {
  const m = /^(v2-)?([1-9]\d{0,8})$/.exec(param.trim());
  if (!m) return null;
  const n = Number(m[2]);
  if (m[1]) return hasLegacy ? V2_ID_BASE + n : null;
  return n;
}

/**
 * The campaigns contracts a report that names `campaignsContract` covers. A report made against the
 * current contract covers every contract (the scorecard it came from merges v1 and v2); one made against
 * the legacy contract before v2 existed covers only that. Null when the contract is not one of ours.
 */
export function reportScope(campaignsContract: string): Address[] | null {
  if (lc(currentSource.campaigns) === lc(campaignsContract)) return campaignSources.map((s) => s.campaigns);
  const s = sourceOfAddress(campaignsContract);
  return s ? [s.campaigns] : null;
}
