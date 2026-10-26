import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  CROSSED_SPREAD,
  buildReport,
  canonicalize,
  checkReport,
  compareFigures,
  computeFigures,
  parseReport,
  reportHash,
  signingMessage,
  withSignature,
  type ReportBody,
  type ScorecardFigures,
  type VaultProbeRow,
  type VaultSlash,
} from "../src/scorecard.js";

const PX = 10n ** 18n;
const DEC = { base: 18, quote: 6 };
const VAULT = "0x714dAee721B93b3cc6B81eB9a2290a92E331C0e0" as const;
const OWNER = "0xE071a74989784bce375af084069C3aB9b8D872eF" as const;
const CAMPAIGNS = "0xdf532CfBA2B047FD3fA3Df1f879617DF17eBAD1c" as const;
const TOKEN_A = "0xCD57F65c2B0e5881CFC2E609F7CD53b746E1F234" as const;
const TOKEN_B = "0x3A3a8e3D34BB815cc211976C17ccf3376C97d750" as const;
const TX = `0x${"ab".repeat(32)}` as const;
const TX2 = `0x${"cd".repeat(32)}` as const;

/** A passing result: bid 40 x `size` WHYPE, ask 40.1, sizes as given. */
function row(campaignId: number, epoch: number, nonce: number, over: Partial<VaultProbeRow> = {}): VaultProbeRow {
  return {
    campaignId,
    epoch,
    nonce,
    passed: true,
    failMask: 0,
    spreadBps: 12,
    bidPx: (40n * PX).toString(),
    askPx: ((401n * PX) / 10n).toString(),
    bidSize: (10n ** 18n).toString(), // 1 WHYPE
    askSize: (2n * 10n ** 18n).toString(), // 2 WHYPE
    ...over,
  };
}

const failing = (c: number, e: number, n: number) =>
  row(c, e, n, { passed: false, failMask: 1, spreadBps: CROSSED_SPREAD, bidSize: "0", askSize: "0" });

describe("computeFigures", () => {
  it("counts probes and passes and derives uptime from them", () => {
    const f = computeFigures([row(1, 0, 1), row(1, 0, 2), failing(1, 1, 3), row(1, 1, 4)], [], DEC);
    assert.equal(f.probes, 4);
    assert.equal(f.passes, 3);
    assert.equal(f.uptime, 0.75);
  });

  it("reports no figures, not zeros, for a vault no probe has checked", () => {
    const f = computeFigures([], [], DEC);
    assert.equal(f.probes, 0);
    assert.equal(f.uptime, null);
    assert.equal(f.medianSpreadBps, null);
    assert.equal(f.bidDepthQuote, null);
    assert.equal(f.askDepthBase, null);
    assert.deepEqual(f.epochs, []);
  });

  it("takes spread and depth only from passing results", () => {
    const f = computeFigures(
      [
        row(1, 0, 1, { spreadBps: 10 }),
        row(1, 0, 2, { spreadBps: 20 }),
        row(1, 0, 3, { spreadBps: 30 }),
        // A failing result with a wide spread and big sizes must not move any figure.
        row(1, 0, 4, { passed: false, failMask: 4, spreadBps: 900, bidSize: (50n * 10n ** 18n).toString() }),
      ],
      [],
      DEC,
    );
    assert.equal(f.medianSpreadBps, 20);
    assert.equal(f.bidDepthQuote, "40000000"); // 1 WHYPE at 40 USDC, in 6-decimal units
    assert.equal(f.askDepthBase, (2n * 10n ** 18n).toString());
  });

  it("averages the two middle spreads of an even count", () => {
    const f = computeFigures([row(1, 0, 1, { spreadBps: 10 }), row(1, 0, 2, { spreadBps: 13 })], [], DEC);
    assert.equal(f.medianSpreadBps, 11.5);
  });

  it("does not treat the crossed-quote sentinel as a spread", () => {
    const f = computeFigures([row(1, 0, 1, { spreadBps: CROSSED_SPREAD }), row(1, 0, 2, { spreadBps: 8 })], [], DEC);
    assert.equal(f.medianSpreadBps, 8);
  });

  it("takes the upper median of bigint depths, as the indexer does", () => {
    const sizes = [1n, 2n, 3n, 4n].map((n) => n * 10n ** 18n);
    const f = computeFigures(
      sizes.map((s, i) => row(1, 0, i + 1, { askSize: s.toString() })),
      [],
      DEC,
    );
    assert.equal(f.askDepthBase, (3n * 10n ** 18n).toString());
  });

  it("scales bid notional by token decimals", () => {
    // 2.5 WHYPE bid at 41.2 USDC = 103 USDC = 103_000_000 raw (6 decimals).
    const f = computeFigures(
      [row(1, 0, 1, { bidPx: ((412n * PX) / 10n).toString(), bidSize: ((25n * 10n ** 18n) / 10n).toString() })],
      [],
      DEC,
    );
    assert.equal(f.bidDepthQuote, "103000000");
  });

  it("builds per-epoch history across campaigns, ordered", () => {
    const f = computeFigures(
      [row(2, 0, 1), failing(1, 1, 5), row(1, 0, 3), row(1, 0, 4), row(1, 1, 6)],
      [],
      DEC,
    );
    assert.deepEqual(f.epochs, [
      { campaignId: 1, epoch: 0, probes: 2, passes: 2 },
      { campaignId: 1, epoch: 1, probes: 2, passes: 1 },
      { campaignId: 2, epoch: 0, probes: 1, passes: 1 },
    ]);
  });

  it("counts a probe once when its row is read twice", () => {
    const f = computeFigures([row(1, 0, 1), row(1, 0, 1), row(1, 0, 2)], [], DEC);
    assert.equal(f.probes, 2);
  });

  it("is independent of input order", () => {
    const rows = [row(1, 0, 1), failing(1, 0, 2), row(2, 3, 1, { spreadBps: 40 })];
    assert.deepEqual(computeFigures(rows, [], DEC), computeFigures([...rows].reverse(), [], DEC));
  });

  it("keeps slashes, deduplicated, sorted, with lower-cased hashes", () => {
    const slashes: VaultSlash[] = [
      { campaignId: 2, txHash: TX2, slashed: "5" },
      { campaignId: 1, txHash: TX, slashed: "2000000" },
      { campaignId: 1, txHash: TX.toUpperCase().replace("0X", "0x") as `0x${string}`, slashed: "2000000" },
    ];
    const f = computeFigures([], slashes, DEC);
    assert.equal(f.slashes.length, 2);
    assert.deepEqual(
      f.slashes.map((s) => s.campaignId),
      [1, 2],
    );
    assert.equal(f.slashes[0]?.txHash, TX);
  });
});

function sampleBody(over: Partial<ScorecardFigures> = {}): ReportBody {
  const figures = { ...computeFigures([row(1, 0, 1), row(1, 0, 2), failing(1, 1, 3)], [{ campaignId: 1, txHash: TX, slashed: "2000000" }], DEC), ...over };
  return {
    chainId: 99801,
    campaignsContract: CAMPAIGNS,
    vault: VAULT,
    owner: OWNER,
    pair: "WHYPE/PLUMBUSD",
    base: { symbol: "WHYPE", address: TOKEN_A, decimals: 18 },
    quote: { symbol: "PLUMBUSD", address: TOKEN_B, decimals: 6 },
    asOfBlock: 12049937,
    source: "snapshot",
    figures,
  };
}

describe("canonicalize and reportHash", () => {
  it("sorts keys at every depth and omits undefined", () => {
    assert.equal(canonicalize({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: undefined } }), '{"a":{"d":[3,{"x":2,"y":1}]},"b":1}');
  });

  it("gives one hash however the body's keys were ordered", () => {
    const body = sampleBody();
    const shuffled = Object.fromEntries(Object.entries(body).reverse()) as unknown as ReportBody;
    assert.equal(reportHash(body), reportHash(shuffled));
  });

  it("changes when any figure changes", () => {
    const base = reportHash(sampleBody());
    assert.notEqual(base, reportHash(sampleBody({ probes: 99 })));
    assert.notEqual(base, reportHash(sampleBody({ medianSpreadBps: 13 })));
    assert.notEqual(base, reportHash(sampleBody({ slashes: [] })));
  });

  it("refuses a bigint, which JSON cannot carry", () => {
    assert.throws(() => canonicalize({ n: 1n }), /bigint/);
  });

  it("is a 32-byte hex string", () => {
    assert.match(reportHash(sampleBody()), /^0x[0-9a-f]{64}$/);
  });
});

describe("report, label and signature", () => {
  it("keeps the label out of the hash, and omits an empty one", () => {
    const body = sampleBody();
    assert.equal(buildReport(body, "Our MM").hash, buildReport(body).hash);
    assert.equal(buildReport(body, "Our MM").label, "Our MM");
    assert.equal("label" in buildReport(body, "   "), false);
  });

  it("recovers the signer of the signed hash", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const report = buildReport(sampleBody());
    const signature = await account.signMessage({ message: signingMessage(report.hash) });
    const signed = withSignature(report, account.address, signature);
    const checks = await checkReport(signed);
    assert.equal(checks.hashOk, true);
    assert.equal(checks.signature?.recovered, account.address);
    assert.equal(checks.signature?.matchesClaimedSigner, true);
  });

  it("reports an unsigned report as unsigned", async () => {
    const checks = await checkReport(buildReport(sampleBody()));
    assert.equal(checks.signature, null);
    assert.equal(checks.hashOk, true);
  });

  it("flags a body edited after signing, and a signature that is not the claimed signer's", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const other = privateKeyToAccount(generatePrivateKey());
    const report = buildReport(sampleBody());
    const signature = await account.signMessage({ message: signingMessage(report.hash) });

    const tampered = withSignature({ ...report, body: sampleBody({ probes: 1000 }) }, account.address, signature);
    assert.equal((await checkReport(tampered)).hashOk, false);

    const wrongSigner = withSignature(report, other.address, signature);
    const checks = await checkReport(wrongSigner);
    assert.equal(checks.signature?.recovered, account.address);
    assert.equal(checks.signature?.matchesClaimedSigner, false);
  });
});

describe("parseReport", () => {
  const good = () => JSON.stringify(buildReport(sampleBody(), "Our MM"));

  it("round-trips a report", () => {
    const parsed = parseReport(good());
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.deepEqual(parsed.report, buildReport(sampleBody(), "Our MM"));
  });

  it("explains what is wrong with input that is not a report", () => {
    assert.deepEqual(parseReport("not json"), { ok: false, error: "This is not valid JSON." });
    assert.equal(parseReport("{}").ok, false);
    assert.equal(parseReport('{"format":"other"}').ok, false);
    const noBody = JSON.parse(good()) as Record<string, unknown>;
    delete noBody.body;
    assert.equal(parseReport(JSON.stringify(noBody)).ok, false);
  });

  it("rejects malformed addresses, hashes, figures and signatures", () => {
    const edit = (f: (r: Record<string, any>) => void) => {
      const r = JSON.parse(good()) as Record<string, any>;
      f(r);
      return parseReport(JSON.stringify(r)).ok;
    };
    assert.equal(edit((r) => (r.body.vault = "0x123")), false);
    assert.equal(edit((r) => (r.hash = "0x12")), false);
    assert.equal(edit((r) => (r.body.figures.probes = -1)), false);
    assert.equal(edit((r) => (r.body.figures.bidDepthQuote = "1e6")), false);
    assert.equal(edit((r) => (r.body.figures.epochs = [{ campaignId: 1 }])), false);
    assert.equal(edit((r) => (r.signature = "0xabcd")), false); // signature without a signer
    assert.equal(edit((r) => (r.version = 2)), false);
  });
});

describe("compareFigures", () => {
  const figures = () => computeFigures([row(1, 0, 1), row(1, 0, 2), failing(1, 1, 3)], [{ campaignId: 1, txHash: TX, slashed: "2000000" }], DEC);

  it("matches every figure of identical data", () => {
    const checks = compareFigures(figures(), figures());
    assert.equal(checks.length, 8);
    assert.ok(checks.every((c) => c.match));
  });

  it("flags only the figure that differs", () => {
    const claimed = { ...figures(), probes: 4 };
    const checks = compareFigures(claimed, figures());
    assert.deepEqual(
      checks.filter((c) => !c.match).map((c) => c.key),
      ["probes"],
    );
    assert.equal(checks.find((c) => c.key === "probes")?.claimed, "4");
    assert.equal(checks.find((c) => c.key === "probes")?.actual, "3");
  });

  it("compares a missing figure with a present one as a mismatch, not as zero", () => {
    const claimed = { ...figures(), medianSpreadBps: null };
    const check = compareFigures(claimed, figures()).find((c) => c.key === "medianSpreadBps");
    assert.equal(check?.match, false);
    assert.equal(check?.claimed, "none");
  });

  it("names the epoch or slash that differs", () => {
    const base = figures();
    const claimed: ScorecardFigures = {
      ...base,
      epochs: [...base.epochs.slice(0, 1), { campaignId: 1, epoch: 1, probes: 9, passes: 9 }],
      slashes: [],
    };
    const checks = compareFigures(claimed, base);
    assert.match(checks.find((c) => c.key === "epochs")?.detail ?? "", /campaign 1 epoch 1 differs/);
    assert.match(checks.find((c) => c.key === "slashes")?.detail ?? "", /on-chain but not in the report/);
  });
});
