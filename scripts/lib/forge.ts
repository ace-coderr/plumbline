import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { ROOT } from "./env.js";

const CONTRACTS = join(ROOT, "contracts");

/** Locate forge, falling back to the default foundryup install dir. */
function forgeBin(): string {
  const probe = spawnSync("forge", ["--version"], { encoding: "utf8", shell: false });
  if (probe.status === 0) return "forge";
  const exe = process.platform === "win32" ? "forge.exe" : "forge";
  return join(homedir(), ".foundry", "bin", exe);
}

/** Run forge in contracts/ with inherited stdio. Secrets go through `env`, never argv. */
export function forge(args: string[], env: Record<string, string> = {}): void {
  const res = spawnSync(forgeBin(), args, {
    cwd: CONTRACTS,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (res.status !== 0) throw new Error(`forge ${args[0] ?? ""} failed (exit ${String(res.status)})`);
}

/** Run forge and capture stdout. */
export function forgeCapture(args: string[], env: Record<string, string> = {}): string {
  const res = spawnSync(forgeBin(), args, {
    cwd: CONTRACTS,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  if (res.status !== 0) throw new Error(`forge ${args[0] ?? ""} failed: ${res.stderr}`);
  return res.stdout;
}

export const CONTRACTS_DIR = CONTRACTS;
