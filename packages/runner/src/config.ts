import { deployment, currentSource, parseSchedule, type Address } from "@plumbline/shared";
import raw from "../../../bots.schedule.json" with { type: "json" };

/**
 * The schedule is bundled into the Worker at deploy time and validated when the Worker starts, so a
 * malformed bots.schedule.json fails loudly at deploy, never silently at 09:00. Changing the schedule
 * means committing the file and deploying again.
 */
export const schedule = parseSchedule(raw);

export const CAMPAIGNS: Address = currentSource.campaigns;
export const WHYPE = deployment.tokens.WHYPE;
export const PLUMBUSD = (deployment.demoTokens as Record<string, { address: Address; decimals: number }>).PLUMBUSD as { address: Address; decimals: number };
export const HL_INFO_URL = "https://api.hyperliquid-testnet.xyz/info";

/** A quote is stale after this many ms without a fresh reference price, and gets cancelled. */
export const MAX_REFERENCE_AGE_MS = 5_000;
