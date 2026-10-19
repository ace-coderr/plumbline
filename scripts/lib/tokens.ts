import { erc20Abi, getAddress, type PublicClient } from "viem";
import type { TokenInfo } from "./addresses.js";

/**
 * Canonical Elysium testnet tokens. Look-alike tokens exist, so each address is checked on-chain
 * (code present, expected symbol) before use, and decimals are always read from the contract.
 */
export const CANONICAL = {
  WHYPE: "0xCD57F65c2B0e5881CFC2E609F7CD53b746E1F234",
  USDC: "0x7D29d8047B905000459c0E80c34a26CeedcB47b2",
} as const;

export async function readCanonicalTokens(client: PublicClient): Promise<Record<string, TokenInfo>> {
  const out: Record<string, TokenInfo> = {};
  for (const [expected, raw] of Object.entries(CANONICAL)) {
    const address = getAddress(raw);
    const code = await client.getCode({ address });
    if (!code || code === "0x") throw new Error(`${expected} at ${address} has no code`);
    const [symbol, name, decimals] = await Promise.all([
      client.readContract({ address, abi: erc20Abi, functionName: "symbol" }),
      client.readContract({ address, abi: erc20Abi, functionName: "name" }),
      client.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
    ]);
    if (symbol !== expected) throw new Error(`${address}: expected symbol ${expected}, got ${symbol}`);
    out[expected] = { address, symbol, name, decimals };
  }
  return out;
}
