import { getAddress } from "viem";
import { deployment } from "./addresses.js";

export type Address = `0x${string}`;

export interface TokenRef {
  address: Address;
  symbol: string;
  decimals: number;
  /** True for mintable demo stand-ins (e.g. PLUMBUSD). The UI must label these, never pass them off as real. */
  demo?: boolean;
}

interface TokenInfo {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
}

/** Demo tokens the seed deployed, widened so an empty record still types as a token map. */
const demoTokens = deployment.demoTokens as Record<string, TokenInfo>;

/** Canonical tokens plus any demo tokens from the deployment record. */
export function knownTokens(): TokenRef[] {
  const canonical = Object.values(deployment.tokens).map((t) => ({
    address: getAddress(t.address),
    symbol: t.symbol,
    decimals: t.decimals,
  }));
  const demo = Object.values(demoTokens).map((t) => ({
    address: getAddress(t.address),
    symbol: t.symbol,
    decimals: t.decimals,
    demo: true,
  }));
  return [...canonical, ...demo];
}

/** True when `addressOrSymbol` names a demo asset. */
export function isDemoToken(addressOrSymbol: string): boolean {
  const k = addressOrSymbol.toLowerCase();
  return Object.values(demoTokens).some((t) => t.address.toLowerCase() === k || t.symbol.toLowerCase() === k);
}

export function tokenBySymbol(symbol: string): TokenRef | undefined {
  const s = symbol.toUpperCase();
  return knownTokens().find((t) => t.symbol.toUpperCase() === s);
}

export function tokenByAddress(address: string): TokenRef | undefined {
  const a = address.toLowerCase();
  return knownTokens().find((t) => t.address.toLowerCase() === a);
}

/** URL-safe pair id, e.g. "WHYPE-USDC". */
export function pairSlug(base: string, quote: string): string {
  return `${base}-${quote}`;
}

export function parsePairSlug(slug: string): { base: string; quote: string } | null {
  const m = /^([A-Za-z0-9.]+)-([A-Za-z0-9.]+)$/.exec(slug);
  if (!m || !m[1] || !m[2]) return null;
  return { base: m[1], quote: m[2] };
}
