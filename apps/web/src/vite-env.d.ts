/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
  readonly VITE_KEEPER_BASE?: string;
  readonly VITE_RPC_URL?: string;
  readonly VITE_DATA_MODE?: "live" | "static";
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
