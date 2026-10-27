import { getAddress, isHex, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { deployment, type BotsSchedule, type RunnerWallet } from "@plumbline/shared";
import { expandSecrets, makeRedactor } from "./core/redact.js";

/**
 * Bindings and secrets. The secrets are Cloudflare Worker secrets, set by the owner and never in this
 * repository. There is deliberately no deployer key here: the runner cannot use it because it is
 * never given it, and `accountFor` refuses a key that belongs to the deployer anyway.
 */
export interface Env {
  SUPERVISOR: DurableObjectNamespace;
  ROLE: DurableObjectNamespace;
  KEEPER_KEY?: string;
  QUOTER_A_KEY?: string;
  QUOTER_B_KEY?: string;
  SPONSOR_KEY?: string;
  MAKER_A_KEY?: string;
  MAKER_B_KEY?: string;
  ADMIN_TOKEN?: string;
  /** A private Conduit node URL with its API key in the path. Used first; the public nodes are the fallback. */
  CONDUIT_RPC_URL?: string;
  /** The treasury wallet's key. It may only send HYPE to the addresses in bots.schedule.json. */
  TREASURY_KEY?: string;
  /** Telegram bot token and the chat id to alert (both set by the owner). */
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  /** A heartbeat monitor's ping address (it usually carries an ID in the path). Optional; read only by the supervisor. */
  HEALTHCHECK_URL?: string;
}

/** Which secret holds which wallet's key. */
export const WALLET_SECRET: Record<RunnerWallet, keyof Env> = {
  keeper: "KEEPER_KEY",
  quoterA: "QUOTER_A_KEY",
  quoterB: "QUOTER_B_KEY",
  sponsor: "SPONSOR_KEY",
  makerA: "MAKER_A_KEY",
  makerB: "MAKER_B_KEY",
};

export const SECRET_NAMES = [...Object.values(WALLET_SECRET), "ADMIN_TOKEN", "CONDUIT_RPC_URL", "TREASURY_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "HEALTHCHECK_URL"] as const;

/** Every secret value present, and the parts of a URL secret that carry its key, for the redactor. */
export function secretValues(env: Env): string[] {
  const raw = SECRET_NAMES.map((n) => env[n as keyof Env]).filter((v): v is string => typeof v === "string" && v.length > 0);
  return expandSecrets(raw);
}

/** The redactor for this Worker's secrets. */
export const redactorFor = (env: Env): ((s: string) => string) => makeRedactor(secretValues(env));

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * The account for a runner wallet, or null if its secret is not set. Throws, with no key in the
 * message, if the secret is malformed, belongs to the deployer, or is not the address that
 * bots.schedule.json lists for this wallet (a key pasted into the wrong secret).
 */
export function accountFor(env: Env, wallet: RunnerWallet | "treasury", schedule: BotsSchedule): PrivateKeyAccount | null {
  const name = wallet === "treasury" ? "TREASURY_KEY" : WALLET_SECRET[wallet];
  const raw = env[name];
  if (typeof raw !== "string" || raw === "") return null;
  const key = (raw.startsWith("0x") ? raw : `0x${raw}`).trim();
  if (!isHex(key) || key.length !== 66) throw new Error(`${name} is not a 32-byte hex private key`);
  const account = privateKeyToAccount(key as Hex);
  if (same(account.address, deployment.deployer)) throw new Error(`${name} is the deployer's key: the runner never uses it`);
  const listed = wallet === "treasury" ? schedule.treasury.address : schedule.wallets[wallet];
  const field = wallet === "treasury" ? "treasury.address" : `wallets.${wallet}`;
  if (listed === null) throw new Error(`${field} is null in bots.schedule.json: set it to ${getAddress(account.address)}`);
  if (!same(account.address, listed)) throw new Error(`${name} does not belong to ${field} (${listed}): it is another wallet's key`);
  return account;
}
