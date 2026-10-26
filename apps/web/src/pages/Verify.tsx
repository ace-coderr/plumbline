import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  checkReport,
  compareFigures,
  deployment,
  parseReport,
  recomputeFromChain,
  type ChainScorecard,
  type FigureKey,
  type ReportChecks,
  type ScorecardReport,
} from "@plumbline/shared";
import { chainClient } from "../lib/chain";
import { fmtAmt, fmtInt, fmtPct, short } from "../lib/format";
import { AddrLink, Badge, Button, Panel, Page, PageHeader, Table, Td, Th } from "../components/ui";

const MAX_FILE = 2_000_000;

type Verdict = "MATCH" | "MISMATCH" | "UNSIGNED";

interface Row {
  label: string;
  reported: string;
  onChain: string;
  verdict: Verdict;
  detail?: string;
}

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const FIGURE_LABEL: Record<FigureKey, string> = {
  probes: "Probes that checked the vault",
  passes: "Probes passed",
  uptime: "Uptime",
  medianSpreadBps: "Median spread",
  bidDepthQuote: "Verified bid depth (median)",
  askDepthBase: "Verified ask depth (median)",
  slashes: "Slashes",
  epochs: "Epochs probed",
};

/** A figure's value in words for the table. `raw` is "none" when there is no value. */
function showFigure(key: FigureKey, raw: string, report: ScorecardReport): string {
  if (raw === "none") return "none";
  const { base, quote } = report.body;
  switch (key) {
    case "uptime":
      return fmtPct(Number(raw), 2);
    case "medianSpreadBps":
      return `${raw} bps`;
    case "bidDepthQuote":
      return `${fmtAmt(raw, quote.decimals, 4)} ${quote.symbol}`;
    case "askDepthBase":
      return `${fmtAmt(raw, base.decimals, 6)} ${base.symbol}`;
    default:
      return fmtInt(Number(raw));
  }
}

function buildRows(report: ScorecardReport, checks: ReportChecks, chain: ChainScorecard): Row[] {
  const b = report.body;
  const rows: Row[] = [];
  rows.push({
    label: "Report hash",
    reported: report.hash,
    onChain: checks.recomputedHash,
    verdict: checks.hashOk ? "MATCH" : "MISMATCH",
    detail: checks.hashOk ? undefined : "the report body was changed after the hash was made",
  });
  if (checks.signature) {
    rows.push({
      label: "Signature recovers to the stated signer",
      reported: report.signer ?? "none",
      onChain: checks.signature.recovered,
      verdict: checks.signature.matchesClaimedSigner ? "MATCH" : "MISMATCH",
    });
    rows.push({
      label: "Signer owns the vault",
      reported: checks.signature.recovered,
      onChain: chain.owner,
      verdict: eq(checks.signature.recovered, chain.owner) ? "MATCH" : "MISMATCH",
      detail: eq(checks.signature.recovered, chain.owner) ? undefined : "the signer is not the vault's owner on-chain",
    });
  } else {
    rows.push({
      label: "Signature",
      reported: "none",
      onChain: "—",
      verdict: "UNSIGNED",
      detail: "unsigned: the figures can be checked, but nobody has put their name to them",
    });
  }
  rows.push({ label: "Vault owner", reported: b.owner, onChain: chain.owner, verdict: eq(b.owner, chain.owner) ? "MATCH" : "MISMATCH" });
  rows.push({
    label: "Base token",
    reported: b.base.address,
    onChain: chain.base.address,
    verdict: eq(b.base.address, chain.base.address) && b.base.decimals === chain.base.decimals ? "MATCH" : "MISMATCH",
  });
  rows.push({
    label: "Quote token",
    reported: b.quote.address,
    onChain: chain.quote.address,
    verdict: eq(b.quote.address, chain.quote.address) && b.quote.decimals === chain.quote.decimals ? "MATCH" : "MISMATCH",
  });
  for (const c of compareFigures(b.figures, chain.figures)) {
    rows.push({
      label: FIGURE_LABEL[c.key],
      reported: showFigure(c.key, c.claimed, report),
      onChain: showFigure(c.key, c.actual, report),
      verdict: c.match ? "MATCH" : "MISMATCH",
      detail: c.detail,
    });
  }
  return rows;
}

const looksAddress = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s);

type Parsed = { ok: true; report: ScorecardReport; checks: ReportChecks } | { ok: false; error: string };
type ChainState =
  | { kind: "idle" }
  | { kind: "running"; fraction: number }
  | { kind: "done"; chain: ChainScorecard }
  | { kind: "error"; message: string };

export function VerifyPage() {
  const [text, setText] = useState("");
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [chain, setChain] = useState<ChainState>({ kind: "idle" });
  const fileInput = useRef<HTMLInputElement>(null);
  const run = useRef(0);

  async function inspect(source: string) {
    run.current += 1;
    setChain({ kind: "idle" });
    const p = parseReport(source);
    if (!p.ok) return setParsed(p);
    try {
      setParsed({ ok: true, report: p.report, checks: await checkReport(p.report) });
    } catch (err) {
      setParsed({ ok: false, error: `The signature could not be read: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  async function load(file: File) {
    if (file.size > MAX_FILE) return setParsed({ ok: false, error: "That file is too large to be a report." });
    const s = await file.text();
    setText(s);
    await inspect(s);
  }

  async function recompute(report: ScorecardReport) {
    const mine = ++run.current;
    const from = deployment.deployBlock;
    const span = Math.max(1, report.body.asOfBlock - from);
    setChain({ kind: "running", fraction: 0 });
    try {
      const result = await recomputeFromChain(chainClient, {
        vault: report.body.vault,
        asOfBlock: BigInt(report.body.asOfBlock),
        onProgress: (b) => {
          if (run.current === mine) setChain({ kind: "running", fraction: Math.min(1, (Number(b) - from) / span) });
        },
      });
      if (run.current === mine) setChain({ kind: "done", chain: result });
    } catch (err) {
      if (run.current === mine) setChain({ kind: "error", message: err instanceof Error ? err.message.split("\n")[0] ?? "failed" : String(err) });
    }
  }

  const report = parsed?.ok ? parsed.report : null;
  const sameDeployment =
    report !== null && report.body.chainId === deployment.chainId && eq(report.body.campaignsContract, deployment.contracts.campaigns);
  const rows = report && parsed?.ok && chain.kind === "done" ? buildRows(report, parsed.checks, chain.chain) : null;
  const mismatches = rows?.filter((r) => r.verdict === "MISMATCH").length ?? 0;
  const unsigned = rows?.some((r) => r.verdict === "UNSIGNED") ?? false;

  return (
    <Page density="dense">
      <PageHeader
        title="Verify a report"
        sub="Paste or upload a scorecard report. This page reads the vault's probe logs from the chain itself, recomputes every figure, and shows MATCH or MISMATCH for each. It does not ask the indexer."
      />

      <Panel title="1 · The report">
        <div className="space-y-3">
          <textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setParsed(null);
              setChain({ kind: "idle" });
            }}
            spellCheck={false}
            rows={8}
            placeholder='Paste the report JSON here: {"format":"plumbline-scorecard", …}'
            aria-label="Report JSON"
            className="num w-full rounded-[8px] border-2 border-ink bg-paper p-3 text-xs text-ink outline-none placeholder:text-muted focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-violet"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" disabled={!text.trim()} onClick={() => void inspect(text)}>
              Check report
            </Button>
            <Button onClick={() => fileInput.current?.click()}>Upload a file</Button>
            <input
              ref={fileInput}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void load(f);
                e.target.value = "";
              }}
            />
            <span className="text-xs text-muted">
              Nothing is uploaded: the file is read in this browser. Get one from the{" "}
              <Link to="/scorecard" className="link">
                scorecard
              </Link>
              .
            </span>
          </div>
          {parsed && !parsed.ok && <p className="rounded-[8px] border-2 border-ink bg-paper p-3 text-sm font-semibold text-danger-text">{parsed.error}</p>}
        </div>
      </Panel>

      {report && parsed?.ok && (
        <>
          <Panel title="2 · What the report claims">
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              {[
                ["Pair", report.body.pair],
                ["Figures as of block", fmtInt(report.body.asOfBlock)],
                ["Source when made", report.body.source],
                ["Chain", String(report.body.chainId)],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3 border-b border-dotted border-ink py-1">
                  <dt className="text-muted">{k}</dt>
                  <dd className="num font-semibold">{v}</dd>
                </div>
              ))}
              <div className="flex justify-between gap-3 border-b border-dotted border-ink py-1">
                <dt className="text-muted">Vault</dt>
                <dd>{looksAddress(report.body.vault) && <AddrLink address={report.body.vault} n={6} />}</dd>
              </div>
              <div className="flex justify-between gap-3 border-b border-dotted border-ink py-1">
                <dt className="text-muted">Owner</dt>
                <dd>{looksAddress(report.body.owner) && <AddrLink address={report.body.owner} n={6} />}</dd>
              </div>
              <div className="flex justify-between gap-3 border-b border-dotted border-ink py-1">
                <dt className="text-muted">Probes · passed</dt>
                <dd className="num font-semibold">
                  {fmtInt(report.body.figures.probes)} · {fmtInt(report.body.figures.passes)}
                </dd>
              </div>
              <div className="flex justify-between gap-3 border-b border-dotted border-ink py-1">
                <dt className="text-muted">Signed</dt>
                <dd className="num font-semibold">{report.signature ? `by ${short(report.signer, 6)}` : "no"}</dd>
              </div>
            </dl>
            {report.body.figures.probes === 0 && (
              <p className="mt-3 text-sm">This report says the vault has no probes, so there are no uptime, spread or depth figures. Recomputing checks that too.</p>
            )}
          </Panel>

          <Panel title="3 · Recompute from the chain">
            {!sameDeployment ? (
              <p className="text-sm leading-6 text-danger-text">
                This report is for chain <span className="num">{report.body.chainId}</span>, contract{" "}
                <span className="num">{short(report.body.campaignsContract, 6)}</span>. This page checks Elysium testnet (chain{" "}
                <span className="num">{deployment.chainId}</span>), campaigns contract{" "}
                <span className="num">{short(deployment.contracts.campaigns, 6)}</span>, so it cannot verify this report.
              </p>
            ) : (
              <div className="space-y-3">
                <p className="text-sm leading-6">
                  Reads every <span className="num">ProbeResult</span> and <span className="num">Penalized</span> event for the vault from block{" "}
                  <span className="num">{fmtInt(deployment.deployBlock)}</span> to block <span className="num">{fmtInt(report.body.asOfBlock)}</span> in
                  chunks, then recomputes the figures. It takes about twenty seconds.
                </p>
                <Button variant="primary" disabled={chain.kind === "running"} onClick={() => void recompute(report)}>
                  {chain.kind === "running" ? "Reading the chain…" : chain.kind === "done" ? "Recompute again" : "Recompute from the chain"}
                </Button>
                {chain.kind === "running" && (
                  <div role="progressbar" aria-valuenow={Math.round(chain.fraction * 100)} aria-valuemin={0} aria-valuemax={100} className="h-3 w-full overflow-hidden rounded-[6px] border-2 border-ink bg-paper">
                    <div className="h-full bg-violet" style={{ width: `${Math.max(2, chain.fraction * 100)}%` }} />
                  </div>
                )}
                {chain.kind === "error" && <p className="num text-sm font-semibold text-danger-text">Could not read the chain: {chain.message}</p>}
              </div>
            )}
          </Panel>

          {rows && chain.kind === "done" && (
            <Panel
              title="Result"
              pad={false}
              right={
                <span className="num">
                  read {fmtInt(chain.chain.eventCounts.probeResults)} ProbeResult + {fmtInt(chain.chain.eventCounts.penalties)} Penalized events
                </span>
              }
            >
              <div className="border-b-2 border-ink px-3 py-3">
                {mismatches === 0 ? (
                  <p className="text-sm font-semibold">
                    <Badge tone="pass">all match</Badge> Every figure in the report matches the chain.
                    {unsigned ? " The report is unsigned, so it does not prove who stands behind it." : ""}
                  </p>
                ) : (
                  <p className="text-sm font-semibold">
                    <Badge tone="fail">mismatch</Badge> {mismatches} item{mismatches === 1 ? "" : "s"} in this report {mismatches === 1 ? "does" : "do"} not
                    match the chain.
                  </p>
                )}
              </div>
              <Table>
                <thead>
                  <tr>
                    <Th>Item</Th>
                    <Th>In the report</Th>
                    <Th>Recomputed on-chain</Th>
                    <Th right>Result</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.label}>
                      <Td className="whitespace-normal">
                        {r.label}
                        {r.detail && <div className="text-2xs text-muted">{r.detail}</div>}
                      </Td>
                      <Td mono>
                        <span title={r.reported}>{r.reported.startsWith("0x") && r.reported.length > 20 ? short(r.reported, 8) : r.reported}</span>
                      </Td>
                      <Td mono>
                        <span title={r.onChain}>{r.onChain.startsWith("0x") && r.onChain.length > 20 ? short(r.onChain, 8) : r.onChain}</span>
                      </Td>
                      <Td right>
                        <Badge tone={r.verdict === "MATCH" ? "pass" : r.verdict === "MISMATCH" ? "fail" : "none"}>{r.verdict}</Badge>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Panel>
          )}
        </>
      )}
    </Page>
  );
}
