import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev-server upstreams; configurable, defaulting to the local services.
const indexer = process.env.INDEXER_URL ?? "http://127.0.0.1:8788";
const keeper = process.env.KEEPER_URL ?? "http://127.0.0.1:8787";

// `vite build --mode static` produces the snapshot site: data from /snapshot/*.json, no API.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  define: {
    "import.meta.env.VITE_DATA_MODE": JSON.stringify(mode === "static" ? "static" : "live"),
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      "/api": { target: indexer, changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, "") },
      "/keeper": { target: keeper, changeOrigin: true, rewrite: (p) => p.replace(/^\/keeper/, "") },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    chunkSizeWarningLimit: 1800,
  },
}));
