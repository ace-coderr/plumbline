/**
 * Run the keeper and the two maker bots against the live deployment with one command, under a HYPE
 * budget.
 *
 *   pnpm build:bots     once, to build the keeper and the bots
 *   pnpm live:bots      keeper + maker A + maker B, with a daily spend cap and balance floors
 *   pnpm live:bots --dev   run from the TypeScript sources instead of the builds
 *
 * The bots spend gas, nothing else. This supervisor watches the three gas wallets (keeper, quoter A,
 * quoter B) and stops all of them, with a SIGINT so the bots pull their quotes first, when
 *   - the HYPE they spent since 00:00 UTC reaches LIVE_BOTS_DAILY_HYPE (default 0.002), or
 *   - any of the three wallets falls below LIVE_BOTS_STOP_BELOW_HYPE (default 0.0002).
 * After a daily stop it waits for the next UTC day and starts again if every wallet is above the floor.
 * After a floor stop it stays stopped: the wallet needs HYPE, and a person has to decide that.
 *
 * Everything is logged to the terminal and to logs/live-bots-<UTC date>.log (ignored by git). Keys are
 * read from .env by the child processes and never printed.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, formatEther, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { elysiumTestnet } from "@plumbline/shared";
import { loadEnv, hexKey, ROOT } from "./lib/env.js";

loadEnv();
const dev = process.argv.includes("--dev");
const tsx = join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
const LOG_DIR = join(ROOT, "logs");
const rpcUrl = process.env.LIVE_BOTS_RPC_URL ?? process.env.INDEXER_RPC_URL ?? process.env.ELYSIUM_RPC_URL ?? elysiumTestnet.rpcUrls.default.http[0];

const num = (name: string, fallback: number): number => {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a number of HYPE, got "${v}"`);
  return n;
};
const dailyCap = parseEther(String(num("LIVE_BOTS_DAILY_HYPE", 0.002)));
const floor = parseEther(String(num("LIVE_BOTS_STOP_BELOW_HYPE", 0.0002)));
const checkMs = num("LIVE_BOTS_CHECK_SECONDS", 20) * 1000;
const statusMs = 60_000;

const utcDay = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
function log(line: string): void {
  const text = `${new Date().toISOString()} ${line}`;
  console.log(text);
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(join(LOG_DIR, `live-bots-${utcDay()}.log`), text + "\n");
  } catch {
    // a log file that cannot be written must not stop the bots from being supervised
  }
}

const wallets = [
  { name: "keeper", address: privateKeyToAccount(hexKey("KEEPER_PRIVATE_KEY")).address },
  { name: "quoter-A", address: privateKeyToAccount(hexKey("QUOTER_A_PRIVATE_KEY")).address },
  { name: "quoter-B", address: privateKeyToAccount(hexKey("QUOTER_B_PRIVATE_KEY")).address },
];
const client = createPublicClient({ chain: elysiumTestnet, transport: http(rpcUrl, { timeout: 10_000, retryCount: 2 }) });

async function balances(): Promise<bigint[]> {
  return Promise.all(wallets.map((w) => client.getBalance({ address: w.address })));
}

interface Svc {
  name: string;
  color: number;
  pkg: string;
  env: Record<string, string>;
  delayMs: number;
}
const services: Svc[] = [
  // An empty list makes the keeper probe every active campaign on the current campaigns contract.
  { name: "keeper", color: 33, pkg: "packages/keeper", env: { KEEPER_CAMPAIGNS: process.env.LIVE_BOTS_CAMPAIGNS ?? "" }, delayMs: 0 },
  { name: "maker-A", color: 32, pkg: "packages/maker-bot", env: { MAKER_BOT: "A" }, delayMs: 4_000 },
  { name: "maker-B", color: 35, pkg: "packages/maker-bot", env: { MAKER_BOT: "B" }, delayMs: 8_000 },
];

let children: ChildProcess[] = [];
let timers: NodeJS.Timeout[] = [];

function launch(s: Svc): void {
  const entry = dev ? join(ROOT, s.pkg, "src", "index.ts") : join(ROOT, s.pkg, "dist", "index.js");
  const cmd = dev ? tsx : process.execPath;
  const child = spawn(cmd, [entry], {
    cwd: ROOT,
    env: { ...process.env, ...s.env, FORCE_COLOR: "0" },
    shell: process.platform === "win32" && cmd.endsWith(".cmd"),
  });
  const tag = `${s.name.padEnd(8)} | `;
  const pipe = (stream: NodeJS.ReadableStream | null) => {
    let buf = "";
    stream?.on("data", (d: Buffer) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      for (const l of lines) if (l.trim()) log(tag + l);
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);
  child.on("exit", (code) => log(`${tag}exited (${String(code)})`));
  children.push(child);
}

function startAll(): void {
  for (const s of services) {
    if (!dev && !existsSync(join(ROOT, s.pkg, "dist", "index.js"))) {
      throw new Error(`${s.pkg}/dist is missing: run  pnpm build:bots  first (or use --dev)`);
    }
  }
  timers = services.map((s) => setTimeout(() => launch(s), s.delayMs));
}

async function stopAll(reason: string): Promise<void> {
  log(`stopping bots: ${reason}`);
  for (const t of timers) clearTimeout(t);
  for (const c of children) c.kill("SIGINT");
  const alive = children;
  children = [];
  await new Promise<void>((r) => setTimeout(r, 4_000));
  for (const c of alive) if (c.exitCode === null) c.kill("SIGKILL");
}

let day = utcDay();
let startBalances: bigint[] = [];
let running = false;
let halted: "floor" | "daily" | null = null;
const startedAt = Date.now();

const hype = (wei: bigint) => formatEther(wei);
const spentSince = (now: bigint[]) => startBalances.reduce((a, b, i) => a + (b > (now[i] ?? 0n) ? b - (now[i] ?? 0n) : 0n), 0n);

async function check(): Promise<void> {
  let now: bigint[];
  try {
    now = await balances();
  } catch (err) {
    log(`balance check failed (${err instanceof Error ? err.message.split("\n")[0] : String(err)}); bots left as they are`);
    return;
  }
  if (utcDay() !== day) {
    day = utcDay();
    startBalances = now;
    if (halted === "daily") {
      halted = null;
      log("new UTC day: daily budget reset");
    }
  }
  if (!running && halted === null) {
    const low = wallets.filter((_, i) => (now[i] ?? 0n) < floor);
    if (low.length) {
      halted = "floor";
      log(`not starting: ${low.map((w) => w.name).join(", ")} below the ${hype(floor)} HYPE floor. Fund them or lower LIVE_BOTS_STOP_BELOW_HYPE.`);
      return;
    }
    startBalances = startBalances.length ? startBalances : now;
    startAll();
    running = true;
    return;
  }
  if (!running) return;
  const spent = spentSince(now);
  const low = wallets.filter((_, i) => (now[i] ?? 0n) < floor);
  if (low.length) {
    running = false;
    halted = "floor";
    await stopAll(`${low.map((w) => `${w.name} (${hype(now[wallets.indexOf(w)] ?? 0n)} HYPE)`).join(", ")} below the ${hype(floor)} HYPE floor. Stays stopped until funded.`);
  } else if (spent >= dailyCap) {
    running = false;
    halted = "daily";
    await stopAll(`spent ${hype(spent)} HYPE today, the daily cap is ${hype(dailyCap)}. Resumes after 00:00 UTC.`);
  }
}

let lastStatus = 0;
async function status(): Promise<void> {
  if (Date.now() - lastStatus < statusMs) return;
  lastStatus = Date.now();
  try {
    const now = await balances();
    const spent = spentSince(now);
    const hours = Math.max((Date.now() - startedAt) / 3_600_000, 1 / 3600);
    log(
      `status ${running ? "running" : `stopped (${halted ?? "idle"})`} | spent today ${hype(spent)} of ${hype(dailyCap)} HYPE | ${wallets
        .map((w, i) => `${w.name} ${hype(now[i] ?? 0n)}`)
        .join(" · ")} | run rate ${(Number(spent) / 1e18 / hours).toFixed(5)} HYPE/h`,
    );
  } catch {
    // reported on the next tick
  }
}

async function main(): Promise<void> {
  log(`live bots: daily cap ${hype(dailyCap)} HYPE, floor ${hype(floor)} HYPE per wallet, rpc ${new URL(rpcUrl).host}, ${dev ? "sources" : "builds"}`);
  startBalances = await balances();
  for (const [i, w] of wallets.entries()) log(`${w.name.padEnd(8)} ${w.address} ${hype(startBalances[i] ?? 0n)} HYPE`);
  await check();
  const loop = setInterval(() => {
    void check().then(status);
  }, checkMs);
  const quit = () => {
    clearInterval(loop);
    void stopAll("interrupted").then(() => process.exit(0));
  };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
}

main().catch((err: unknown) => {
  log(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
