import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** Load the repo-root .env into process.env if present (Node 20.12+ built-in parser). */
export function loadEnv(): void {
  const path = join(ROOT, ".env");
  if (existsSync(path)) process.loadEnvFile(path);
}

export function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env var ${name} (see .env.example)`);
  return v;
}

export function hexKey(name: string): `0x${string}` {
  const v = need(name);
  const k = v.startsWith("0x") ? v : `0x${v}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error(`${name} is not a 32-byte hex private key`);
  return k as `0x${string}`;
}
