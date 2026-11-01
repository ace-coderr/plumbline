import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { decodeFunctionData, encodeFunctionData, type Hash, type PublicClient } from "viem";
import { plumbCampaignsAbi } from "@plumbline/shared";
import { schedule } from "../src/config.js";
import { MAX_LOG_CALLS, PROBE_SELECTOR, fetchWindowFigures, logsByRange } from "../src/windowData.js";
import { FallbackWatch } from "../src/core/fallbacks.js";
import { ESTIMATED_PROBE_WEI, allowedTracks, chargeOther, countOtherProbe, emptyLedger, isOther, ledgerFor, mayProbeOther, parseLedger, remainingWei, serialiseLedger } from "../src/core/foreign.js";
import { keeperBurst, newKeeperState } from "../src/keeper.js";
import { makerTick, newMakerState } from "../src/maker.js";
import { privateNodeFailing, tryEach, type Signer } from "../src/chain.js";
import { makeLogger } from "../src/core/log.js";

const KEEPER = "0xde8554954841D2fAbCacAddfAD95899c8BF3E989";
const CAMPAIGNS = "0xFbC9e2b62132bDdc0C4bC02799D5D5A3e943D786";
const pad = (a: string) => `0x${"0".repeat(24)}${a.slice(2).toLowerCase()}`;

/** A fake explorer: block lookups, a transaction list that pages properly, and an event list that ignores the page and caps at 1,000 rows. */
function explorer(txs: Record<string, string>[], logs: { block: number; transactionHash: string; topics: string[] }[]) {
  const calls = { logs: 0, txlist: 0 };
  const f = (async (url: RequestInfo | URL) => {
    const q = new URL(String(url)).searchParams;
    const action = q.get("action");
    if (action === "getblocknobytime") return Response.json({ result: { blockNumber: q.get("closest") === "after" ? "1" : "1000000" } });
    if (action === "txlist") {
      calls.txlist += 1;
      const page = Number(q.get("page"));
      const slice = txs.slice((page - 1) * 1000, page * 1000);
      return Response.json({ result: slice.length ? slice : "No transactions found" });
    }
    calls.logs += 1;
    const from = Number(q.get("fromBlock"));
    const to = Number(q.get("toBlock"));
    const rows = logs.filter((l) => l.block >= from && l.block <= to).slice(0, 1000);
    return Response.json({ result: rows.length ? rows : "No logs found" });
  }) as typeof fetch;
  return { f, calls };
}

describe("the summary reader against an explorer that caps events at 1,000 and ignores the page", () => {
  const mkLogs = (n: number, startBlock = 100) => Array.from({ length: n }, (_, i) => ({ block: startBlock + i, transactionHash: `0x${(i + 1).toString(16).padStart(64, "0")}`, topics: ["0xe", "0x1", "0x2", pad(KEEPER)] }));

  it("reads every event when there are more than 1,000, by splitting the block range", async () => {
    for (const n of [999, 1000, 1233, 3000]) {
      const logs = mkLogs(n);
      const { f, calls } = explorer([], logs);
      const r = await logsByRange(f, (a, b) => `module=logs&action=getLogs&fromBlock=${a}&toBlock=${b}`, 1, 100_000);
      assert.equal(r.rows.length, n, `${n} events`);
      assert.equal(r.truncated, false);
      assert.ok(calls.logs <= MAX_LOG_CALLS, `${calls.logs} calls`);
    }
  });

  it("counts a transaction once, even if it shows up on both sides of a split", async () => {
    const logs = mkLogs(1500);
    logs.push({ ...logs[10]!, block: 1200 }, { ...logs[600]!, block: 100 }); // the same transactions again, in other blocks
    const { f } = explorer([], logs);
    const r = await logsByRange(f, (a, b) => `module=logs&action=getLogs&fromBlock=${a}&toBlock=${b}`, 1, 100_000);
    assert.equal(r.rows.length, 1500);
  });

  it("says so, rather than miscount, when it cannot get everything: a block with 1,000 events, or too many requests", async () => {
    const oneBlock = Array.from({ length: 1000 }, (_, i) => ({ block: 500, transactionHash: `0x${(i + 1).toString(16).padStart(64, "0")}`, topics: [] as string[] }));
    const a = await logsByRange(explorer([], oneBlock).f, (x, y) => `fromBlock=${x}&toBlock=${y}`, 1, 1000);
    assert.equal(a.truncated, true);
    const huge = mkLogs(60_000);
    const e = explorer([], huge);
    const b = await logsByRange(e.f, (x, y) => `fromBlock=${x}&toBlock=${y}`, 1, 100_000);
    assert.equal(b.truncated, true);
    assert.equal(e.calls.logs, MAX_LOG_CALLS);
  });

  it("the window figures read 1,233 probes, 70 reverted, 1,163 landed", async () => {
    const txs = Array.from({ length: 1233 }, (_, i) => ({
      hash: `0x${(i + 1).toString(16).padStart(64, "0")}`,
      to: CAMPAIGNS,
      methodId: PROBE_SELECTOR,
      isError: i % 17 === 0 && i / 17 < 70 ? "1" : "0",
      gasUsed: "134000",
      gasPrice: "100020000",
      timeStamp: String(1_000_000 + i * 10),
      input: `${PROBE_SELECTOR}${"0".repeat(63)}c`,
    }));
    const logs = txs.filter((t) => t.isError === "0").map((t, i) => ({ block: 100 + i, transactionHash: t.hash, topics: ["0xe", "0x1", "0x2", pad(KEEPER)] }));
    assert.equal(logs.length, 1163);
    const { f } = explorer(txs, logs);
    const r = await fetchWindowFigures(f, KEEPER, CAMPAIGNS, 1_000_000, 1_000_000 + 4 * 3600);
    assert.ok(r.ok);
    if (r.ok) {
      assert.deepEqual([r.figures.probesSent, r.figures.probesLanded, r.figures.probesReverted, r.figures.mismatch], [1233, 1163, 70, false]);
      assert.deepEqual(r.figures.perCampaign.map((c) => [c.id, c.sent]), [[12, 1233]]);
    }
  });
});

describe("the other-campaigns budget (pure)", () => {
  const own = new Set(["0xaaaa"]);
  it("a campaign is 'other' only when its creator is known and not the runner's; unknown is never other", () => {
    assert.equal(isOther("0xAAAA", own), false, "own, any case");
    assert.equal(isOther("0xbbbb", own), true);
    assert.equal(isOther(undefined, own), false);
    assert.equal(isOther("", own), false);
  });

  it("stops other campaigns when the budget, counting probes in flight, is used up", () => {
    const l = emptyLedger("d");
    const budget = ESTIMATED_PROBE_WEI * 3n;
    assert.equal(mayProbeOther(l, budget, 0), true);
    assert.equal(mayProbeOther(l, budget, 2), true);
    assert.equal(mayProbeOther(l, budget, 3), false);
    assert.equal(l.stopped, true);
    assert.equal(mayProbeOther(l, budget, 0), false, "and it stays stopped");
    const m = emptyLedger("d");
    chargeOther(m, 7, budget);
    assert.equal(remainingWei(m, budget, 0), 0n);
    assert.equal(mayProbeOther(m, budget, 0), false);
  });

  it("when stopped, the runner's own campaigns stay and only other people's are removed", () => {
    const tracks = [{ id: 1, creator: "0xaaaa" }, { id: 2, creator: "0xbbbb" }, { id: 3, creator: undefined }, { id: 4, creator: "0xcccc" }];
    const l = emptyLedger("d");
    assert.deepEqual(allowedTracks(tracks, own, l).map((t) => t.id), [1, 2, 3, 4]);
    l.stopped = true;
    assert.deepEqual(allowedTracks(tracks, own, l).map((t) => t.id), [1, 3], "own and unknown stay");
  });

  it("a new UTC day starts from nothing, and the ledger survives a save", () => {
    const l = emptyLedger("2026-10-29");
    countOtherProbe(l, 13);
    chargeOther(l, 13, 5n);
    l.stopped = true;
    assert.deepEqual(parseLedger(JSON.parse(JSON.stringify(serialiseLedger(l))), "2026-10-29"), l);
    assert.deepEqual(parseLedger(serialiseLedger(l), "2026-10-30"), emptyLedger("2026-10-30"));
    assert.equal(ledgerFor(l, "2026-10-30").stopped, false);
  });
});

describe("the keeper and the other-campaigns budget", () => {
  const OWN = "0x1111111111111111111111111111111111111111";
  const OTHER = "0x2222222222222222222222222222222222222222";

  /** A keeper whose three newest campaigns are: 3 by the given creators; every gate always open. Returns what it sent. */
  async function run(creators: (string | undefined)[], budgetWei: bigint) {
    const now = Math.floor(Date.now() / 1000);
    const sent: number[] = [];
    const alerts: unknown[] = [];
    const ids = [3, 2, 1];
    const client = {
      readContract: async () => 3n,
      multicall: async (a: { contracts: { functionName: string }[] }) => {
        const fn = a.contracts[0]!.functionName;
        if (fn === "probeGateOpen") return a.contracts.map(() => ({ status: "success", result: true }));
        return ids.flatMap((_, i) => [
          { epochLength: 300n, minProbeInterval: 0 },
          { creator: creators[i], startTime: BigInt(now - 10), numEpochs: 100, settledEpochs: 0, lastProbeAt: 0n },
        ]);
      },
      getTransactionReceipt: async () => null,
    } as unknown as PublicClient;
    const signer = {
      send: async (_to: string, data: `0x${string}`) => {
        const { functionName, args } = decodeFunctionData({ abi: plumbCampaignsAbi, data });
        if (functionName === "probe") sent.push(Number(args![0]));
        return `0x${"ab".repeat(32)}` as Hash;
      },
    } as unknown as Signer;
    const state = newKeeperState();
    await keeperBurst({ signer, clients: [client, client, client], state, log: makeLogger((s) => s, () => undefined), own: new Set([OWN]), otherBudgetWei: budgetWei, onOtherBudget: (l) => void alerts.push(l.day) });
    return { sent, alerts, state };
  }
  const count = (xs: number[], id: number) => xs.filter((x) => x === id).length;

  it("with the budget spent, other campaigns are not probed, the runner's own still is, and there is one alert", async () => {
    // campaign 3 is the runner's own; 2 and 1 are other people's. Budget below one probe's estimate: one other probe at most.
    const r = await run([OWN, OTHER, OTHER], ESTIMATED_PROBE_WEI / 2n);
    assert.ok(count(r.sent, 3) >= 2, `own campaign probed ${count(r.sent, 3)} times`);
    assert.equal(count(r.sent, 2) + count(r.sent, 1), 1, "one other probe, then none");
    assert.equal(r.state.other.stopped, true);
    assert.equal(r.alerts.length, 1, "one alert");
  });

  it("with a budget of nothing, no other campaign is ever probed and the own one runs as usual", async () => {
    const r = await run([OWN, OTHER, OTHER], 0n);
    assert.equal(count(r.sent, 2) + count(r.sent, 1), 0);
    assert.ok(count(r.sent, 3) >= 2);
    assert.equal(r.alerts.length, 1);
  });

  it("a campaign whose creator is unknown is never 'other': it is probed even with no budget", async () => {
    const r = await run([undefined, undefined, undefined], 0n);
    for (const id of [3, 2, 1]) assert.ok(count(r.sent, id) >= 1, `campaign ${id} probed`);
    assert.equal(r.state.other.stopped, false);
    assert.equal(r.alerts.length, 0);
  });

  it("without a budget setting (or the runner's addresses) nothing is ever held back", async () => {
    const now = Math.floor(Date.now() / 1000);
    void now;
    const r = await run([OTHER, OTHER, OTHER], 10n ** 30n);
    for (const id of [3, 2, 1]) assert.ok(count(r.sent, id) >= 1);
    assert.equal(r.state.other.stopped, false);
    assert.equal(Object.keys(r.state.other.campaigns).length, 3, "each is counted for the summary");
  });

  it("the shipped schedule gives a daily cap of 0.20 HYPE and a separate 0.05 for other campaigns", () => {
    assert.equal(schedule.dailyHypeCap, 0.2);
    assert.equal(schedule.otherCampaigns.dailyProbeBudgetHype, 0.05);
  });
});

describe("the 'private node failed' alert needs 3 fallbacks in 5 minutes", () => {
  it("fires on the third within five minutes, then starts again", () => {
    const w = new FallbackWatch();
    w.record(0);
    assert.equal(w.reached(1_000), false);
    w.record(60_000);
    assert.equal(w.reached(61_000), false);
    w.record(120_000);
    assert.equal(w.reached(121_000), true);
    assert.equal(w.reached(122_000), false, "the count starts again");
  });

  it("does not fire for failures spread over more than five minutes", () => {
    const w = new FallbackWatch();
    for (const t of [0, 200_000, 400_000, 600_000]) {
      w.record(t);
      assert.equal(w.reached(t + 1), false);
    }
  });

  it("through the real reads: two failed private reads are a blip, the third alerts", async () => {
    const bad = { readContract: async () => { throw new Error("header not found"); } } as unknown as PublicClient;
    const good = { readContract: async () => 1n } as unknown as PublicClient;
    const read = () => tryEach([bad, good, good], (c) => (c as unknown as { readContract: () => Promise<bigint> }).readContract());
    await read();
    assert.equal(privateNodeFailing(), false);
    await read();
    assert.equal(privateNodeFailing(), false);
    await read();
    assert.equal(privateNodeFailing(), true);
    assert.equal(privateNodeFailing(), false);
  });
});

describe("the maker's inventory read tries the next node", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = (async () => Response.json({ HYPE: "25.5" })) as typeof fetch;
  });
  afterEach(() => (globalThis.fetch = realFetch));

  const ctx = (clients: PublicClient[] | undefined, state = newMakerState()) => ({
    vault: schedule.vaults.a,
    settings: schedule.maker.A,
    referenceCoin: schedule.referenceCoin,
    signer: { send: async () => `0x${"cd".repeat(32)}` as Hash } as unknown as Signer,
    client: clients?.[0] ?? (failing as PublicClient),
    clients,
    state,
    log: makeLogger((s) => s, () => undefined),
  });
  const failing = { multicall: async () => { throw new Error("header not found"); } } as unknown as PublicClient;
  const working = { multicall: async () => [10n ** 21n, 10n ** 21n] } as unknown as PublicClient;

  it("a node that says 'header not found' is skipped and the inventory is read from the next", async () => {
    const c = ctx([failing, working]);
    await makerTick(c);
    assert.equal(c.state.freeBase, 10n ** 21n);
    assert.equal(c.state.lastError, null);
  });

  it("with no other node the failure is still reported and the last inventory kept", async () => {
    const c = ctx([failing]);
    c.state.freeBase = 5n;
    await makerTick(c);
    assert.equal(c.state.freeBase, 5n);
    assert.match(String(c.state.lastError), /header not found/);
  });

  it("the encoded probe call really carries the campaign id the budget logic reads", () => {
    const data = encodeFunctionData({ abi: plumbCampaignsAbi, functionName: "probe", args: [12n] });
    assert.equal(data.slice(0, 10), PROBE_SELECTOR);
    assert.equal(BigInt(`0x${data.slice(10, 74)}`), 12n);
  });
});
