import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { elysiumTestnet } from "@plumbline/shared";

export const wagmiConfig = createConfig({
  chains: [elysiumTestnet],
  connectors: [injected()],
  // VITE_RPC_URL points the dashboard at a local fork during development.
  transports: { [elysiumTestnet.id]: http(import.meta.env.VITE_RPC_URL ?? elysiumTestnet.rpcUrls.default.http[0]) },
  pollingInterval: 500,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
