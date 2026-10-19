import { test } from "node:test";
import assert from "node:assert/strict";
import { quoteNotional, spreadBps } from "@plumbline/shared";
import { buildQuote } from "./pricing.js";

const base = {
  spreadBps: 12,
  skewBps: 4,
  targetSize: 10n ** 18n,
  baseDecimals: 18,
  quoteDecimals: 6,
};

test("balanced inventory quotes symmetric around mid", () => {
  const q = buildQuote({ ...base, mid: "40", freeBase: 5n * 10n ** 18n, freeQuote: 200_000_000n });
  assert.equal(q.imbalance, 0);
  assert.equal(spreadBps(q.bidPx, q.askPx), 12n);
  assert.ok(q.bidPx < 40n * 10n ** 18n && q.askPx > 40n * 10n ** 18n);
});

test("long base skews prices down", () => {
  const q = buildQuote({ ...base, mid: "40", freeBase: 10n * 10n ** 18n, freeQuote: 0n });
  assert.ok(q.imbalance > 0.99);
  assert.ok(q.askPx < 40n * 10n ** 18n * 10_010n / 10_000n);
  assert.equal(q.bidSize, 0n, "no quote inventory, no bid");
});

test("sizes never exceed what the vault holds", () => {
  const q = buildQuote({ ...base, mid: "42.5", freeBase: 3n * 10n ** 17n, freeQuote: 5_000_000n });
  assert.ok(q.askSize <= 3n * 10n ** 17n);
  assert.ok(quoteNotional(q.bidSize, q.bidPx, 18, 6) <= 5_000_000n);
});
