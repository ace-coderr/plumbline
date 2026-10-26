import { createPublicClient, http, type PublicClient } from "viem";
import { elysiumTestnet } from "@plumbline/shared";

/** Read-only client for Elysium. /verify uses it to read logs itself, not through the indexer. */
export const chainClient: PublicClient = createPublicClient({
  chain: elysiumTestnet,
  transport: http(import.meta.env.VITE_RPC_URL ?? elysiumTestnet.rpcUrls.default.http[0]),
});
