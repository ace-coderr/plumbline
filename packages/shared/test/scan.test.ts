import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chunkRanges, scanRange } from "../src/chainScorecard.js";

describe("chunkRanges", () => {
  it("covers the range exactly, inclusive, with no overlap", () => {
    const r = chunkRanges(100n, 1049n, 400n);
    assert.deepEqual(r, [
      { from: 100n, to: 499n },
      { from: 500n, to: 899n },
      { from: 900n, to: 1049n },
    ]);
  });

  it("returns one range when it fits, and none for an empty range", () => {
    assert.deepEqual(chunkRanges(5n, 9n, 100n), [{ from: 5n, to: 9n }]);
    assert.deepEqual(chunkRanges(10n, 9n, 100n), []);
  });

  it("handles a single block", () => {
    assert.deepEqual(chunkRanges(7n, 7n, 3n), [{ from: 7n, to: 7n }]);
  });
});

describe("scanRange", () => {
  /** A fake node that rejects any request wider than `limit` blocks and returns one item per block. */
  const node = (limit: bigint) => {
    const calls: { from: bigint; to: bigint }[] = [];
    return {
      calls,
      fetch: async (from: bigint, to: bigint) => {
        calls.push({ from, to });
        if (to - from + 1n > limit) throw new Error("query returned more than 10000 results");
        const items: bigint[] = [];
        for (let b = from; b <= to; b++) items.push(b);
        return items;
      },
    };
  };
  const fast = { retries: 0, retryDelayMs: 0 };

  it("returns every item once, in order, across chunks", async () => {
    const n = node(1_000n);
    const out = await scanRange(1n, 250n, n.fetch, { ...fast, chunk: 100n });
    assert.equal(out.length, 250);
    assert.deepEqual(out.slice(0, 3), [1n, 2n, 3n]);
    assert.equal(out.at(-1), 250n);
  });

  it("splits a range the node refuses until it fits, without losing or repeating blocks", async () => {
    const n = node(64n);
    const out = await scanRange(1n, 1_000n, n.fetch, { ...fast, chunk: 1_000n, minChunk: 8n });
    assert.equal(out.length, 1_000);
    assert.equal(new Set(out).size, 1_000);
    assert.deepEqual(out, [...out].sort((a, b) => (a < b ? -1 : 1)));
  });

  it("retries a transient failure before splitting", async () => {
    let failures = 1;
    const out = await scanRange(
      1n,
      10n,
      async (a, b) => {
        if (failures-- > 0) throw new Error("429");
        return [a, b];
      },
      { chunk: 10n, retries: 2, retryDelayMs: 0 },
    );
    assert.deepEqual(out, [1n, 10n]);
  });

  it("gives up with the node's error when a minimal range still fails", async () => {
    await assert.rejects(
      scanRange(1n, 100n, async () => Promise.reject(new Error("node down")), { ...fast, chunk: 100n, minChunk: 10n }),
      /node down/,
    );
  });

  it("reports progress through the last block read", async () => {
    const seen: bigint[] = [];
    await scanRange(1n, 250n, async () => [], { ...fast, chunk: 100n, onProgress: (b) => seen.push(b) });
    assert.deepEqual(seen, [100n, 200n, 250n]);
  });
});
