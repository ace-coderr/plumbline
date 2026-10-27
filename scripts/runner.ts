/**
 * Everyday runner commands, so no key or token has to be typed or pasted anywhere:
 *
 *   pnpm runner kill | resume | tick | alert-test | topup-plan
 *   pnpm runner topup-test <wallet> <hype>      one live transfer of at most 0.001 HYPE to a listed wallet
 *   pnpm runner new-wallet <ENV_NAME>           makes a key, saves it in .env, prints only the address
 *   pnpm runner put-secrets [SECRET ...]        sends values from .env to Cloudflare secrets (all if none named)
 *   pnpm runner find-chat-id                    reads your Telegram chat id after you message the bot, saves it
 *   pnpm runner secrets                         lists the secret NAMES the Worker has
 *   pnpm runner mint <sponsor|faucet> <amount>  mints demo PLUMBUSD (whole tokens, at most 1,000,000) with the deployer key from .env
 *
 * Values come from the repo-root .env. Nothing secret is printed; the deployer key is not in the list of secrets
 * that can be sent, so it cannot reach Cloudflare through this command.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { createPublicClient, createWalletClient, http, parseAbi, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ELYSIUM_TESTNET, deployment, elysiumTestnet, faucetDeployment, parseSchedule } from "@plumbline/shared";
import { loadEnv, ROOT } from "./lib/env.js";

loadEnv();
const env = process.env;

/** Worker secret name -> the .env name that holds its value. The deployer key is deliberately not here. */
const SECRETS: Record<string, string> = {
  KEEPER_KEY: "KEEPER_PRIVATE_KEY",
  QUOTER_A_KEY: "QUOTER_A_PRIVATE_KEY",
  QUOTER_B_KEY: "QUOTER_B_PRIVATE_KEY",
  MAKER_A_KEY: "MAKER_A_PRIVATE_KEY",
  MAKER_B_KEY: "MAKER_B_PRIVATE_KEY",
  SPONSOR_KEY: "SPONSOR_PRIVATE_KEY",
  TREASURY_KEY: "TREASURY_PRIVATE_KEY",
  ADMIN_TOKEN: "ADMIN_TOKEN",
  CONDUIT_RPC_URL: "CONDUIT_RPC_URL",
  TELEGRAM_BOT_TOKEN: "TELEGRAM_BOT_TOKEN",
  TELEGRAM_CHAT_ID: "TELEGRAM_CHAT_ID",
};

const secretValues = () =>
  Object.entries(env)
    .filter(([k, v]) => /KEY|TOKEN|SECRET|PRIVATE|RPC_URL|CHAT_ID/.test(k) && typeof v === "string" && v.length >= 8)
    .map(([, v]) => v as string);
const scrub = (s: string) => secretValues().reduce((a, v) => a.split(v).join("[redacted]"), s);
const die = (m: string): never => {
  console.error(scrub(m));
  process.exit(1);
};

const wrangler = (args: string[], input?: string) =>
  spawnSync("npx", ["wrangler", ...args], { cwd: join(ROOT, "packages/runner"), input, encoding: "utf8", shell: true, env: process.env });

async function admin(path: string, method = "POST"): Promise<void> {
  const base = (env.RUNNER_URL ?? "").replace(/\/$/, "");
  if (!base || !env.ADMIN_TOKEN) die("RUNNER_URL and ADMIN_TOKEN must be in .env");
  const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${env.ADMIN_TOKEN}` }, signal: AbortSignal.timeout(30_000) });
  const text = scrub(await res.text());
  console.log(res.status, text.length > 1500 ? `${text.slice(0, 1500)}…` : text);
  if (!res.ok) process.exit(1);
}

function putSecrets(names: string[]): void {
  const list = names.length ? names : Object.keys(SECRETS);
  let failed = 0;
  for (const name of list) {
    const from = SECRETS[name];
    if (!from) {
      console.log(`${name}: not an allowed secret name (allowed: ${Object.keys(SECRETS).join(", ")})`);
      failed++;
      continue;
    }
    const value = env[from];
    if (!value) {
      console.log(`${name}: skipped, ${from} is not in .env`);
      continue;
    }
    const r = wrangler(["secret", "put", name], `${value}\n`);
    const out = scrub(`${r.stdout}${r.stderr}`);
    if (r.status === 0 && /Success|Uploaded/i.test(out)) console.log(`${name}: set`);
    else {
      failed++;
      console.log(`${name}: FAILED ${out.split("\n").filter(Boolean).slice(-2).join(" ")}`);
    }
  }
  process.exit(failed ? 1 : 0);
}

async function findChatId(): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) die("TELEGRAM_BOT_TOKEN is not in .env");
  const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`).catch((e: Error) => die(`could not reach Telegram: ${e.message}`));
  const body = (await (res as Response).json()) as { ok: boolean; description?: string; result: { message?: { chat: { id: number; type: string } } }[] };
  if (!body.ok) die(`Telegram said no: ${body.description ?? "unknown"}`);
  const ids = new Set(body.result.map((u) => u.message?.chat).filter((c): c is { id: number; type: string } => !!c && c.type === "private").map((c) => String(c.id)));
  if (ids.size === 0) die("no private chat found. Open your bot in Telegram, press Start or send it any message, then run this again.");
  if (ids.size > 1) die(`more than one private chat has messaged the bot (${[...ids].join(", ")}); not guessing. Remove the extra ones by revoking the token in @BotFather if they are not yours.`);
  const id = [...ids][0]!;
  if (!env.TELEGRAM_CHAT_ID) appendFileSync(join(ROOT, ".env"), `${readFileSync(join(ROOT, ".env"), "utf8").endsWith("\n") ? "" : "\n"}TELEGRAM_CHAT_ID=${id}\n`);
  console.log(`chat id: ${id}${env.TELEGRAM_CHAT_ID ? " (already in .env)" : " (saved to .env)"}. Next: pnpm runner put-secrets TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID`);
}

function newWallet(name: string | undefined): void {
  if (!name || !/^[A-Z][A-Z0-9_]*_PRIVATE_KEY$/.test(name)) die("give an env name that ends in _PRIVATE_KEY, e.g. KEEPER_PRIVATE_KEY");
  if (name === "DEPLOYER_PRIVATE_KEY") die("this command never touches the deployer key");
  const file = join(ROOT, ".env");
  const cur = readFileSync(file, "utf8");
  if (new RegExp(`^${name}=.+`, "m").test(cur)) die(`${name} is already in .env. To replace it, delete that line first (keep a backup of the old key until its funds are moved).`);
  const key = generatePrivateKey();
  appendFileSync(file, `${cur.endsWith("\n") ? "" : "\n"}${name}=${key}\n`);
  console.log(`${name} saved to .env. Address: ${privateKeyToAccount(key).address}`);
}

/** Mints PLUMBUSD from the deployer key (read from .env, used only to sign here) to the sponsor or the faucet, and to no one else. */
async function mint(who: string | undefined, amount: string | undefined): Promise<void> {
  const schedule = parseSchedule(JSON.parse(readFileSync(join(ROOT, "bots.schedule.json"), "utf8")));
  const to: Address | null | undefined = who === "sponsor" ? schedule.wallets.sponsor : who === "faucet" ? faucetDeployment?.address : undefined;
  if (!to) return die("usage: pnpm runner mint <sponsor|faucet> <amount>");
  const n = Number(amount);
  if (!Number.isInteger(n) || n < 1 || n > 1_000_000) return die("the amount is a whole number of PLUMBUSD, 1 to 1,000,000");
  const raw = env.DEPLOYER_PRIVATE_KEY;
  if (!raw) return die("DEPLOYER_PRIVATE_KEY is not in .env");
  const token = (deployment.demoTokens as Record<string, { address: Address; decimals: number }>).PLUMBUSD!;
  const abi = parseAbi(["function mint(address to, uint256 amount)", "function balanceOf(address) view returns (uint256)"]);
  const account = privateKeyToAccount((raw.startsWith("0x") ? raw : `0x${raw}`) as `0x${string}`);
  const pub = createPublicClient({ chain: elysiumTestnet, transport: http(ELYSIUM_TESTNET.rpcUrl) });
  const wallet = createWalletClient({ account, chain: elysiumTestnet, transport: http(ELYSIUM_TESTNET.rpcUrl) });
  const hash = await wallet.writeContract({ address: token.address, abi, functionName: "mint", args: [to, BigInt(n) * 10n ** BigInt(token.decimals)] });
  const rc = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
  const bal = await pub.readContract({ address: token.address, abi, functionName: "balanceOf", args: [to] });
  console.log(`mint ${rc.status}: ${n} PLUMBUSD to the ${who}, new balance ${Number(bal) / 10 ** token.decimals}, tx ${hash}`);
  if (rc.status !== "success") process.exit(1);
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case "kill":
  case "resume":
  case "tick":
  case "alert-test":
  case "topup-plan":
    await admin(`/${cmd}`);
    break;
  case "topup-test":
    await admin(`/topup-test?wallet=${encodeURIComponent(rest[0] ?? "")}&hype=${encodeURIComponent(rest[1] ?? "")}`);
    break;
  case "new-wallet":
    newWallet(rest[0]);
    break;
  case "put-secrets":
    putSecrets(rest);
    break;
  case "mint":
    await mint(rest[0], rest[1]);
    break;
  case "find-chat-id":
    await findChatId();
    break;
  case "secrets": {
    const r = wrangler(["secret", "list"]);
    const names = [...`${r.stdout}`.matchAll(/"name":\s*"([A-Z_0-9]+)"/g)].map((m) => m[1]);
    console.log(names.length ? names.join("\n") : scrub(`${r.stdout}${r.stderr}`));
    break;
  }
  default:
    console.log("commands: kill, resume, tick, alert-test, topup-plan, topup-test <wallet> <hype>, new-wallet <ENV_NAME>, put-secrets [NAME...], find-chat-id, secrets, mint <sponsor|faucet> <amount>");
}
