import { createPublicClient, fallback, http, type PublicClient } from "viem";
import { ELYSIUM_TESTNET, elysiumTestnet } from "@plumbline/shared";

/**
 * The public Elysium nodes, in order. The second is the Conduit endpoint, used when the first fails
 * or rate-limits. VITE_RPC_URL (a build-time setting) puts your own node first.
 */
export const RPC_URLS: string[] = [
  ...(import.meta.env.VITE_RPC_URL ? [import.meta.env.VITE_RPC_URL] : []),
  ELYSIUM_TESTNET.rpcUrl,
  "https://rpc-elysium-testnet.t.conduit.xyz",
];

/**
 * Read-only client for Elysium. Each node gets a short timeout (a hung request is treated as a
 * failure) and one quick retry; a node that still fails hands over to the next at once, so a dead
 * node costs a fraction of a second, not seconds. When every node has failed, the whole round is
 * retried after a pause, so a rate limit waits instead of failing. Verify and the live reader both
 * read through this.
 */
export const chainClient: PublicClient = createPublicClient({
  chain: elysiumTestnet,
  transport: fallback(
    RPC_URLS.map((url) => http(url, { timeout: 12_000, retryCount: 1, retryDelay: 300 })),
    { retryCount: 2, retryDelay: 1_500 },
  ),
  batch: { multicall: true },
});
