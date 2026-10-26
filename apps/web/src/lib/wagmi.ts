import { createConfig, createStorage, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { elysiumTestnet } from "@plumbline/shared";

/**
 * wagmi remembers the last connection in localStorage. Reading `window.localStorage` can itself throw
 * (site data blocked, some private windows), which would otherwise stop the whole app from starting,
 * so storage goes through this wrapper: every call is guarded and falls back to memory.
 */
const memory = new Map<string, string>();
const safeStorage = {
  getItem(key: string): string | null {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return memory.get(key) ?? null;
    }
  },
  setItem(key: string, value: string): void {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      memory.set(key, value);
    }
  },
  removeItem(key: string): void {
    try {
      window.localStorage.removeItem(key);
    } catch {
      memory.delete(key);
    }
  },
};

export const wagmiConfig = createConfig({
  chains: [elysiumTestnet],
  connectors: [injected()],
  storage: createStorage({ storage: safeStorage }),
  // VITE_RPC_URL points the dashboard at a local fork during development.
  transports: { [elysiumTestnet.id]: http(import.meta.env.VITE_RPC_URL ?? elysiumTestnet.rpcUrls.default.http[0]) },
  pollingInterval: 500,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
