import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const indexer = process.env.INDEXER_URL ?? "http://127.0.0.1:8788";
const keeper = process.env.KEEPER_URL ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
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
});
