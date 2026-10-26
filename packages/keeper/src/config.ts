import { envBool, envNumber, envPrivateKey, envString, loadRootEnv } from "@plumbline/shared/node";
import { ELYSIUM_TESTNET } from "@plumbline/shared";

loadRootEnv();

export interface KeeperConfig {
  rpcUrl: string;
  privateKey: `0x${string}`;
  port: number;
  host: string;
  /** How often to poll probe gates, ms. Elysium blocks land every 100-200ms. */
  pollMs: number;
  /** Gate pollers running side by side, taking the poll endpoints in turn. */
  pollers: number;
  /** Endpoints for gate polls, comma-separated; empty uses the main endpoint and the send endpoint. */
  pollUrls: string[];
  /** How often to rediscover campaigns and refresh their state, ms. */
  refreshMs: number;
  /** Restrict to these campaign ids; empty means every active campaign. */
  campaignIds: number[];
  autoSettle: boolean;
  /** Claim accrued probe fees once they exceed this many wei. */
  claimThresholdWei: bigint;
  /** Stop sending once the keeper balance falls below this many wei. 0 disables. */
  stopBelowWei: bigint;
}

function parseIds(raw: string): number[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const n = Number(s);
      if (!Number.isInteger(n) || n <= 0) throw new Error(`bad campaign id "${s}" in KEEPER_CAMPAIGNS`);
      return n;
    });
}

export function loadConfig(): KeeperConfig {
  return {
    rpcUrl: envString("ELYSIUM_RPC_URL", ELYSIUM_TESTNET.rpcUrl),
    privateKey: envPrivateKey("KEEPER_PRIVATE_KEY"),
    port: envNumber("KEEPER_PORT", 8787),
    host: envString("KEEPER_HOST", "0.0.0.0"),
    pollMs: envNumber("KEEPER_POLL_MS", 150),
    pollers: envNumber("KEEPER_POLLERS", 1),
    pollUrls: envString("KEEPER_POLL_URLS", "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    refreshMs: envNumber("KEEPER_REFRESH_MS", 5_000),
    campaignIds: parseIds(envString("KEEPER_CAMPAIGNS", "")),
    autoSettle: envBool("KEEPER_AUTO_SETTLE", true),
    claimThresholdWei: BigInt(envString("KEEPER_CLAIM_THRESHOLD_WEI", "100000000000000000")),
    stopBelowWei: BigInt(envString("KEEPER_STOP_BELOW_WEI", "0")),
  };
}
