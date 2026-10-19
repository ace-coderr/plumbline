import { defineChain } from "viem";

/** Public endpoints for the Elysium testnet (Arbitrum Orbit L2 by Kinetiq, settling to HyperEVM). */
export const ELYSIUM_TESTNET = {
  id: 99801,
  name: "Elysium Testnet",
  rpcUrl: "https://testnet-rpc.elysium.kinetiq.xyz",
  explorerUrl: "https://elysium.kinetiq.xyz/testnet-explorer",
  /** Blockscout backend behind the explorer; used for contract verification and tx lookups. */
  explorerApiUrl: "https://testnet-api.elysium.kinetiq.xyz/api",
  faucetUrl: "https://elysium.kinetiq.xyz/testnet-faucet",
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
} as const;

/** viem chain definition for Elysium testnet. */
export const elysiumTestnet = defineChain({
  id: ELYSIUM_TESTNET.id,
  name: ELYSIUM_TESTNET.name,
  nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
  rpcUrls: {
    default: { http: [ELYSIUM_TESTNET.rpcUrl] },
  },
  blockExplorers: {
    default: {
      name: "Elysium Explorer",
      url: ELYSIUM_TESTNET.explorerUrl,
      apiUrl: ELYSIUM_TESTNET.explorerApiUrl,
    },
  },
  contracts: {
    multicall3: { address: ELYSIUM_TESTNET.multicall3 },
  },
  testnet: true,
});

/** Explorer link for a transaction. */
export function txUrl(hash: string): string {
  return `${ELYSIUM_TESTNET.explorerUrl}/transaction/${hash}`;
}

/** Explorer link for an address. */
export function addressUrl(address: string): string {
  return `${ELYSIUM_TESTNET.explorerUrl}/address/${address}`;
}

/** Explorer link for a block. */
export function blockUrl(block: number | bigint): string {
  return `${ELYSIUM_TESTNET.explorerUrl}/block/${block.toString()}`;
}
