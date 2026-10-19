import { envNumber, envPrivateKey, envString, loadRootEnv } from "@plumbline/shared/node";
import { ELYSIUM_TESTNET, tokenBySymbol, type TokenRef } from "@plumbline/shared";
import { getAddress } from "viem";

loadRootEnv();

export interface BotConfig {
  name: string;
  rpcUrl: string;
  quoterKey: `0x${string}`;
  vault: `0x${string}`;
  base: TokenRef;
  quote: TokenRef;
  /** Hyperliquid coin used as the off-chain reference mid. */
  referenceCoin: string;
  referenceUrl: string;
  /** Full quoted spread in bps (bid to ask). */
  spreadBps: number;
  /** Target size per side, in whole base units. */
  size: string;
  /** Max mid shift from inventory imbalance, in bps. */
  skewBps: number;
  refreshMs: number;
  /** Pull the quote if the reference price is older than this. */
  maxReferenceAgeMs: number;
  port: number;
  /** Stop quoting (cancel first) once the quoter balance falls below this many wei. 0 disables. */
  stopBelowWei: bigint;
}

/**
 * Settings come from `MAKER_<NAME>_*` first, then unprefixed `MAKER_*`, so two bots can share one .env:
 * `MAKER_BOT=A pnpm --filter @plumbline/maker-bot start`.
 */
export function loadConfig(): BotConfig {
  const name = (process.env.MAKER_BOT ?? "A").toUpperCase();
  const pick = (key: string, fallback?: string) => {
    const scoped = process.env[`MAKER_${name}_${key}`];
    if (scoped !== undefined && scoped !== "") return scoped;
    return envString(`MAKER_${key}`, fallback);
  };
  const pickNum = (key: string, fallback: number) => {
    const raw = pick(key, String(fallback));
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`MAKER_${name}_${key} must be a number`);
    return n;
  };
  const [baseSym, quoteSym] = pick("PAIR", "WHYPE-USDC").split("-");
  const base = tokenBySymbol(baseSym ?? "");
  const quote = tokenBySymbol(quoteSym ?? "");
  if (!base || !quote) throw new Error(`unknown pair ${baseSym ?? "?"}-${quoteSym ?? "?"}`);

  return {
    name,
    // Bots send the most transactions; MAKER_RPC_URL lets them use a separate endpoint (and rate-limit
    // bucket) from the keeper and indexer.
    rpcUrl: pick("RPC_URL", envString("ELYSIUM_RPC_URL", ELYSIUM_TESTNET.rpcUrl)),
    quoterKey: envPrivateKey(`QUOTER_${name}_PRIVATE_KEY`),
    vault: getAddress(pick("VAULT")),
    base,
    quote,
    referenceCoin: pick("REFERENCE_COIN", "HYPE"),
    referenceUrl: envString("HL_INFO_URL", "https://api.hyperliquid-testnet.xyz/info"),
    spreadBps: pickNum("SPREAD_BPS", 12),
    size: pick("SIZE", "1"),
    skewBps: pickNum("SKEW_BPS", 4),
    refreshMs: pickNum("REFRESH_MS", 500),
    maxReferenceAgeMs: pickNum("MAX_REFERENCE_AGE_MS", 5_000),
    port: envNumber(`MAKER_${name}_PORT`, name === "A" ? 8791 : 8792),
    stopBelowWei: BigInt(pick("STOP_BELOW_WEI", "0")),
  };
}
