/**
 * Node-only helpers for services. Exported from "@plumbline/shared/node" so browser bundles never
 * pull in node built-ins.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** Walk up from `start` to the directory holding pnpm-workspace.yaml. */
export function findRepoRoot(start: string = process.cwd()): string | null {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Load the repo-root .env into process.env (existing variables win). */
export function loadRootEnv(): void {
  const root = findRepoRoot();
  if (!root) return;
  const path = join(root, ".env");
  if (existsSync(path)) process.loadEnvFile(path);
}

export function envString(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v !== undefined && v !== "") return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing env var ${name} (see .env.example)`);
}

export function envNumber(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`env var ${name} must be a number, got "${v}"`);
  return n;
}

export function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v === "1" || v.toLowerCase() === "true";
}

export function envPrivateKey(name: string): `0x${string}` {
  const raw = envString(name);
  const k = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error(`${name} is not a 32-byte hex private key`);
  return k as `0x${string}`;
}

/** Repo-root-relative data directory for service state (gitignored). */
export function dataDir(): string {
  const root = findRepoRoot() ?? process.cwd();
  return join(root, "data");
}

/** Minimal timestamped logger. */
export function makeLogger(service: string) {
  const line = (level: string, msg: string, extra?: Record<string, unknown>) => {
    const ts = new Date().toISOString();
    const tail = extra ? " " + JSON.stringify(extra, (_k, val: unknown) => (typeof val === "bigint" ? val.toString() : val)) : "";
    const out = `${ts} ${level.padEnd(5)} [${service}] ${msg}${tail}`;
    if (level === "error" || level === "warn") console.error(out);
    else console.log(out);
  };
  return {
    info: (msg: string, extra?: Record<string, unknown>) => line("info", msg, extra),
    warn: (msg: string, extra?: Record<string, unknown>) => line("warn", msg, extra),
    error: (msg: string, extra?: Record<string, unknown>) => line("error", msg, extra),
    debug: (msg: string, extra?: Record<string, unknown>) => {
      if (process.env.LOG_LEVEL === "debug") line("debug", msg, extra);
    },
  };
}

export type Logger = ReturnType<typeof makeLogger>;
