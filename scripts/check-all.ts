/**
 * One command to see whether the whole runner setup is healthy:
 *
 *   pnpm check:all                  (add --skip-telegram to not send the test message)
 *
 * It checks, and prints PASS or FAIL for, each line: the RPC nodes answer, the runner's /health is fresh and
 * not halted, a test message reaches your Telegram, every bot wallet is above its floor, the treasury and the
 * PLUMBUSD balances are above their alert levels, and the last window's summary matches the chain.
 * Exit code 1 if anything fails. Reads .env for RUNNER_URL (your runner's workers.dev address), ADMIN_TOKEN and
 * CONDUIT_RPC_URL; nothing secret is printed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, erc20Abi, http, type Address } from "viem";
import { ELYSIUM_TESTNET, RUNNER_WALLETS, deployment, elysiumTestnet, faucetDeployment, parseSchedule, currentSource } from "@plumbline/shared";
import { fetchWindowFigures } from "../packages/runner/src/windowData.js";
import { readBalances } from "../packages/runner/src/chain.js";
import { plumbusdLines, rpcLines, runnerLines, treasuryLine, walletLines, windowLines, type HealthLine, type NodeResult } from "../packages/runner/src/core/health.js";
import { loadEnv, ROOT } from "./lib/env.js";

loadEnv();
const schedule = parseSchedule(JSON.parse(readFileSync(join(ROOT, "bots.schedule.json"), "utf8")));
const skipTelegram = process.argv.includes("--skip-telegram");
let failures = 0;
const pass = (what: string, detail = "") => console.log(`PASS  ${what}${detail ? `: ${detail}` : ""}`);
const fail = (what: string, detail: string) => {
  failures += 1;
  console.log(`FAIL  ${what}: ${detail}`);
};
/** Prints lines built by the runner's own health code, the same code its daily Telegram summary uses. */
const show = (lines: HealthLine[]) => lines.forEach((l) => (l.ok ? pass(l.name, l.detail) : fail(l.name, l.detail)));
const say = (e: unknown) => (e instanceof Error ? (e.message.split("\n")[0] ?? "failed") : String(e)).replace(/https?:\/\/\S+/g, "[url]");

async function main(): Promise<void> {
  // 1. RPC nodes. The private node is named, never its address.
  const nodes: { name: string; url: string }[] = [
    { name: "public node (Elysium)", url: ELYSIUM_TESTNET.rpcUrl },
    { name: "public node (Conduit)", url: "https://rpc-elysium-testnet.t.conduit.xyz" },
    ...(process.env.CONDUIT_RPC_URL ? [{ name: "private node", url: process.env.CONDUIT_RPC_URL }] : []),
  ];
  let reader = createPublicClient({ chain: elysiumTestnet, transport: http(ELYSIUM_TESTNET.rpcUrl) });
  const results: NodeResult[] = [];
  for (const n of nodes) {
    try {
      const c = createPublicClient({ chain: elysiumTestnet, transport: http(n.url, { timeout: 8_000, retryCount: 0 }) });
      const t0 = Date.now();
      const block = await c.getBlockNumber();
      results.push({ name: n.name, ok: true, detail: `block ${block}, ${Date.now() - t0} ms` });
      if (n.name === "private node") reader = c;
    } catch (e) {
      results.push({ name: n.name, ok: false, detail: say(e) });
    }
  }
  show(rpcLines(results));
  if (!process.env.CONDUIT_RPC_URL) console.log("INFO  no private node in .env (CONDUIT_RPC_URL); the runner uses it if its secret is set");

  // 2. Runner health.
  const base = (process.env.RUNNER_URL ?? "").replace(/\/$/, "");
  let health: Record<string, any> | null = null;
  if (!base) fail("runner health", "RUNNER_URL is not in .env (your runner's https://plumbline-runner.<subdomain>.workers.dev address)");
  else {
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      health = (await res.json()) as Record<string, any>;
      show(
        runnerLines({
          nowSec: Math.floor(Date.now() / 1000),
          lastTickAt: health.lastTickAt ?? null,
          killed: Boolean(health.killed),
          halt: health.halt ?? null,
          scheduleEnabled: Boolean(health.scheduleEnabled),
        }),
      );
      if (health.treasury?.alertsConfigured) pass("Telegram secrets", "set on the runner");
      else fail("Telegram secrets", "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not set on the runner");
    } catch (e) {
      fail("runner health", say(e));
    }
  }

  // The heartbeat to the monitoring service: SKIP when not set, PASS when the last ping was answered.
  if (health) {
    const hb = health.heartbeat as { configured: boolean; last: { at: number; ok: boolean | null; failures: number; lastError: string | null } | null; skipped: { reason: string } | null } | undefined;
    if (!hb || !hb.configured) console.log("SKIP  heartbeat: HEALTHCHECK_URL is not set on the runner (optional)");
    else if (!hb.last || hb.last.ok === null) console.log(`INFO  heartbeat: set, no ping yet (the first one is sent within five minutes)${hb.skipped ? `; last skipped because ${hb.skipped.reason}` : ""}`);
    else if (hb.last.ok) pass("heartbeat", `the last ping was answered ${Math.floor(Date.now() / 1000) - hb.last.at} s ago`);
    else fail("heartbeat", `the last ping failed (${hb.last.lastError ?? "no detail"}); ${hb.last.failures} failure(s) so far`);
  }

  // 3. Telegram delivery, through the runner (it holds the secrets).
  if (skipTelegram) console.log("INFO  Telegram delivery skipped (--skip-telegram)");
  else if (!base || !process.env.ADMIN_TOKEN) fail("Telegram delivery", "needs RUNNER_URL and ADMIN_TOKEN in .env");
  else {
    try {
      const res = await fetch(`${base}/alert-test`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: process.env.ADMIN_TOKEN }), signal: AbortSignal.timeout(15_000) });
      const body = (await res.json()) as { ok?: boolean; error?: string };
      if (res.ok && body.ok) pass("Telegram delivery", "Telegram accepted the test message; check your chat for it");
      else fail("Telegram delivery", body.error ?? `HTTP ${res.status}`);
    } catch (e) {
      fail("Telegram delivery", say(e));
    }
  }

  // 4. Balances against the floors and alert levels, with the runner's own line builders.
  try {
    show(walletLines(schedule, await readBalances(reader, schedule)));
    show([treasuryLine(schedule, schedule.treasury.address ? await reader.getBalance({ address: schedule.treasury.address }) : null)]);
    const token = (deployment.demoTokens as Record<string, { address: Address; decimals: number }>).PLUMBUSD!;
    const plum = async (who: Address) => Number(await reader.readContract({ address: token.address, abi: erc20Abi, functionName: "balanceOf", args: [who] })) / 10 ** token.decimals;
    show(plumbusdLines(schedule, schedule.wallets.sponsor ? await plum(schedule.wallets.sponsor) : null, faucetDeployment ? await plum(faucetDeployment.address) : null, Boolean(faucetDeployment)));
  } catch (e) {
    fail("balances", say(e));
  }

  // 5. The last finished window: the runner's own summary against a fresh read of the chain.
  try {
    const now = Math.floor(Date.now() / 1000);
    const day0 = Math.floor(now / 86_400) * 86_400;
    const spans = [0, -86_400].flatMap((off) =>
      schedule.windows.map((w) => {
        const [h, m] = w.startUtc.split(":").map(Number) as [number, number];
        const start = day0 + off + h * 3600 + m * 60;
        return { start, end: start + w.minutes * 60 };
      }),
    );
    const last = spans.filter((s) => s.end + 120 <= now).sort((a, b) => b.start - a.start)[0];
    if (!last || !schedule.wallets.keeper) fail("last window summary", "no finished window found");
    else {
      const label = `${new Date(last.start * 1000).toISOString().slice(0, 16)}Z`;
      const chain = await fetchWindowFigures(fetch, schedule.wallets.keeper, currentSource.campaigns, last.start, last.end);
      if (!chain.ok) fail("last window summary", `the chain could not be read: ${chain.reason}`);
      else {
        const f = chain.figures;
        pass("last window on chain", `${label}: ${f.probesSent} probes sent, ${f.probesLanded} landed, ${f.probesReverted} reverted (${f.revertedPct.toFixed(1)}%), ${f.settles} settles`);
        show(windowLines(f, null));
        const s = health?.lastSummary as { window: number; figures: { probesSent: number; probesLanded: number; probesReverted: number; settles: number } | null } | undefined;
        if (!s) fail("last window summary sent", "the runner has not recorded a summary yet (it sends one a minute after each window, once it runs the current version)");
        else if (s.window !== last.start) fail("last window summary sent", `the runner's latest summary is for another window (${new Date(s.window * 1000).toISOString().slice(0, 16)}Z)`);
        else if (!s.figures) fail("last window summary sent", "the runner could not read the chain when it sent it");
        else if (s.figures.probesSent === f.probesSent && s.figures.probesLanded === f.probesLanded && s.figures.probesReverted === f.probesReverted && s.figures.settles === f.settles) pass("last window summary sent", "the runner's summary matches the chain");
        else fail("last window summary sent", `the runner said ${s.figures.probesSent}/${s.figures.probesLanded}/${s.figures.probesReverted}/${s.figures.settles}, the chain says ${f.probesSent}/${f.probesLanded}/${f.probesReverted}/${f.settles} (sent/landed/reverted/settles)`);
      }
    }
  } catch (e) {
    fail("last window summary", say(e));
  }
}

await main();
console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
