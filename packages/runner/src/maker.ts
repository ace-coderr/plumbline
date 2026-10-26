import { encodeFunctionData, parseUnits, type Address, type PublicClient } from "viem";
import { ELYSIUM_TESTNET, plumbQuoteAbi, type MakerSettings } from "@plumbline/shared";
import { buildQuote } from "../../maker-bot/src/pricing.js";
import { HL_INFO_URL, MAX_REFERENCE_AGE_MS, PLUMBUSD, WHYPE } from "./config.js";
import type { Signer } from "./chain.js";
import { errText, type Logger } from "./core/log.js";

/**
 * One maker tick: refresh the reference price and inventory when due, build the quote the same way the
 * local maker bot does, and send one setQuote. A failed send is counted, never retried inside the tick;
 * ten failures in a row end the run. If the reference price goes stale the quote is cancelled, once.
 */
export interface MakerState {
  ticks: number;
  sent: number;
  failed: number;
  consecutiveFailures: number;
  mid: string | null;
  midAt: number;
  freeBase: bigint;
  freeQuote: bigint;
  invAt: number;
  cancelled: boolean;
  lastSendAt: number;
  lastError: string | null;
}

export const newMakerState = (): MakerState => ({
  ticks: 0,
  sent: 0,
  failed: 0,
  consecutiveFailures: 0,
  mid: null,
  midAt: 0,
  freeBase: 0n,
  freeQuote: 0n,
  invAt: 0,
  cancelled: false,
  lastSendAt: 0,
  lastError: null,
});

export const MAX_CONSECUTIVE_FAILURES = 10;

export interface MakerCtx {
  vault: Address;
  settings: MakerSettings;
  referenceCoin: string;
  signer: Signer;
  client: PublicClient;
  state: MakerState;
  log: Logger;
}

async function pollReference(c: MakerCtx): Promise<void> {
  const started = Date.now();
  try {
    const res = await fetch(HL_INFO_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "allMids" }),
      signal: AbortSignal.timeout(2_500),
    });
    if (!res.ok) throw new Error(`price feed HTTP ${res.status}`);
    const body = (await res.json()) as Record<string, unknown>;
    const v = body[c.referenceCoin];
    if (typeof v !== "string" || !/^\d+(\.\d+)?$/.test(v) || Number(v) <= 0) throw new Error(`no usable mid for ${c.referenceCoin}`);
    c.state.mid = v;
    c.state.midAt = started;
  } catch (err) {
    c.state.lastError = errText(err);
  }
}

async function readInventory(c: MakerCtx): Promise<void> {
  try {
    const [b, q] = await c.client.multicall({
      allowFailure: false,
      multicallAddress: ELYSIUM_TESTNET.multicall3,
      contracts: [
        { address: c.vault, abi: plumbQuoteAbi, functionName: "freeBalance", args: [WHYPE.address] },
        { address: c.vault, abi: plumbQuoteAbi, functionName: "freeBalance", args: [PLUMBUSD.address] },
      ],
    });
    c.state.freeBase = b;
    c.state.freeQuote = q;
    c.state.invAt = Date.now();
  } catch (err) {
    c.state.lastError = errText(err);
  }
}

/** Pull the quote, once. Called when the reference is stale, the inventory is gone, or the run is ending. */
export async function cancelQuote(c: MakerCtx, reason: string): Promise<void> {
  if (c.state.cancelled) return;
  c.state.cancelled = true;
  try {
    await c.signer.send(c.vault, encodeFunctionData({ abi: plumbQuoteAbi, functionName: "cancel" }), 100_000n);
    c.log.warn("quote cancelled", { reason });
  } catch (err) {
    c.log.error("cancel failed", { reason, err: errText(err) });
  }
}

/**
 * Returns "backoff" after ten failed sends in a row: the caller waits before the next tick instead of
 * hammering a node that is refusing us, and ends the run if that keeps happening.
 */
export async function makerTick(c: MakerCtx): Promise<"ok" | "backoff"> {
  const s = c.state;
  s.ticks += 1;
  if (s.ticks === 1 || s.ticks % 2 === 0) await pollReference(c);
  if (s.ticks === 1 || s.ticks % 15 === 0) await readInventory(c);

  if (s.mid === null || Date.now() - s.midAt > MAX_REFERENCE_AGE_MS) {
    await cancelQuote(c, "reference price is stale");
    return "ok";
  }
  const q = buildQuote({
    mid: s.mid,
    spreadBps: c.settings.spreadBps,
    skewBps: c.settings.skewBps,
    targetSize: parseUnits(c.settings.size, WHYPE.decimals),
    freeBase: s.freeBase,
    freeQuote: s.freeQuote,
    baseDecimals: WHYPE.decimals,
    quoteDecimals: PLUMBUSD.decimals,
  });
  if (q.bidSize === 0n && q.askSize === 0n) {
    await cancelQuote(c, "the vault has no inventory");
    return "ok";
  }
  try {
    await c.signer.send(
      c.vault,
      encodeFunctionData({ abi: plumbQuoteAbi, functionName: "setQuote", args: [q.bidPx, q.askPx, q.bidSize, q.askSize] }),
      150_000n,
    );
    s.sent += 1;
    s.consecutiveFailures = 0;
    s.cancelled = false;
    s.lastSendAt = Date.now();
  } catch (err) {
    s.failed += 1;
    s.consecutiveFailures += 1;
    s.lastError = errText(err);
    c.log.warn("setQuote failed", { err: s.lastError, consecutive: s.consecutiveFailures });
    if (s.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      s.consecutiveFailures = 0;
      return "backoff";
    }
  }
  return "ok";
}
