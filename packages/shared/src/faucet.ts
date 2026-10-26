import { deployment } from "./addresses.js";
import type { Address } from "./pairs.js";

/** The deployed PLUMBUSD faucet, or null if there is none. Read from the generated deployment record. */
export interface FaucetDeployment {
  address: Address;
  token: Address;
  /** Raw token units per claim. */
  amount: string;
  /** Seconds between claims for one address. */
  cooldown: number;
  deployBlock: number;
  deployedAt: string;
}

export const faucetDeployment: FaucetDeployment | null = (deployment as { faucet?: FaucetDeployment }).faucet ?? null;
