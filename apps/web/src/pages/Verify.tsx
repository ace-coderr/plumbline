import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  checkReport,
  compareFigures,
  deployment,
  parseReport,
  recomputeFromChain,
  reportScope,
  campaignSources,
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
  const tokenRow = (label: string, r: ScorecardReport["body"]["base"], c: ChainScorecard["base"]): Row => ({
    label,
    reported: `${r.symbol} ${r.address} (${r.decimals} decimals)`,
    onChain: `${c.symbol} ${c.address} (${c.decimals} decimals)`,
    verdict: eq(r.address, c.address) && r.decimals === c.decimals && r.symbol === c.symbol ? "MATCH" : "MISMATCH",
  });
  rows.push(tokenRow("Base token", b.base, chain.base));
  rows.push(tokenRow("Quote token", b.quote, chain.quote));
  const pair = `${chain.base.symbol}/${chain.quote.symbol}`;
  rows.push({ label: "Pair", reported: b.pair, onChain: pair, verdict: b.pair === pair ? "MATCH" : "MISMATCH" });
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
/** `hash` ties a state to the report it was started for, so a slow read can never be shown against another report. */
type ChainState =
  | { kind: "idle" }
  | { kind: "running"; fraction: number; hash: string }
  | { kind: "done"; chain: ChainScorecard; hash: string }
  | { kind: "error"; title: string; detail: string; retryable: boolean; hash: string };

/** Plain words for why reading the chain failed. No failure ever turns into a result. */
function explain(err: unknown): { title: string; detail: string; retryable: boolean } {
  const raw = err instanceof Error ? ((err as { shortMessage?: string }).shortMessage ?? err.message) : String(err);
  const msg = raw.split("\n")[0] ?? "";
  if (/429|rate.?limit|too many requests|exceeded/i.test(msg)) {
    return { title: "The RPC node is rate-limiting this browser.", detail: "Wait a minute, then retry.", retryable: true };
  }
  if (/returned no data|execution reverted|is not a contract|could not decode/i.test(msg)) {
    return { title: "This address does not read as a Plumbline vault.", detail: "The report's vault could not be read on-chain.", retryable: false };
  }
  return {
    title: "Could not read the chain.",
    detail: `The RPC node did not answer in full (${msg.slice(0, 160) || "no message"}). Check your connection, then retry.`,
    retryable: true,
  };
}

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
    run.current += 1;
    if (file.size === 0) return setParsed({ ok: false, error: "That file is empty." });
    if (file.size > MAX_FILE) return setParsed({ ok: false, error: "That file is too large to be a report." });
    const s = await file.text();
    setText(s);
    await inspect(s);
  }

  async function recompute(report: ScorecardReport) {
    const mine = ++run.current;
    const hash = report.hash;
    const from = deployment.deployBlock;
    const span = Math.max(1, report.body.asOfBlock - from);
    const current = () => run.current === mine;
    setChain({ kind: "running", fraction: 0, hash });
    try {
      // A report cannot be as of a block the chain has not reached; refuse before scanning anything.
      const head = await chainClient.getBlockNumber();
      if (BigInt(report.body.asOfBlock) > head) {
        if (current()) {
          setChain({
            kind: "error",
            hash,
            retryable: false,
            title: "This report is as of a block the chain has not reached.",
            detail: `The report says block ${fmtInt(report.body.asOfBlock)}; the chain is at block ${fmtInt(Number(head))}. A real report cannot be from the future.`,
          });
        }
        return;
      }
      const result = await recomputeFromChain(chainClient, {
        vault: report.body.vault,
        asOfBlock: BigInt(report.body.asOfBlock),
        campaigns: reportScope(report.body.campaignsContract) ?? undefined,
        onProgress: (b) => {
          if (current()) setChain({ kind: "running", fraction: Math.min(1, (Number(b) - from) / span), hash });
        },
      });
      if (current()) setChain({ kind: "done", chain: result, hash });
    } catch (err) {
      if (current()) setChain({ kind: "error", hash, ...explain(err) });
    }
  }

  const report = parsed?.ok ? parsed.report : null;
  const sameDeployment =
    report !== null && report.body.chainId === deployment.chainId && reportScope(report.body.campaignsContract) !== null;
  // Only a state started for this very report counts; anything else is ignored, never shown.
  const forThis = report !== null && chain.kind !== "idle" && chain.hash === report.hash;
  const rows = report && parsed?.ok && forThis && chain.kind === "done" ? buildRows(report, parsed.checks, chain.chain) : null;
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
              run.current += 1; // a read still in flight belongs to the old text
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
                <span className="num">{deployment.chainId}</span>), campaigns contracts{" "}
                {campaignSources.map((s, i) => (
                  <span key={s.campaigns}>
                    {i > 0 && ", "}
                    <span className="num">{short(s.campaigns, 6)}</span>
                  </span>
                ))}
                , so it cannot verify this report.
              </p>
            ) : (
              <div className="space-y-3">
                <p className="text-sm leading-6">
                  Reads every <span className="num">ProbeResult</span> and <span className="num">Penalized</span> event for the vault from block{" "}
                  <span className="num">{fmtInt(deployment.deployBlock)}</span> to block <span className="num">{fmtInt(report.body.asOfBlock)}</span> in
                  chunks, then recomputes the figures. It usually takes under a minute, longer if the RPC node throttles you.
                </p>
                <p className="text-xs leading-5 text-muted">
                  It trusts the RPC node it reads from (the public Elysium node): a node that returned false logs could mislead it, so for
                  anything that matters build the app against your own node (<span className="num">VITE_RPC_URL</span>). Signatures from
                  contract wallets such as multisigs are not supported; only a plain-wallet owner can sign.
                </p>
                <Button variant="primary" disabled={forThis && chain.kind === "running"} onClick={() => void recompute(report)}>
                  {forThis && chain.kind === "running"
                    ? "Reading the chain…"
                    : forThis && chain.kind === "done"
                      ? "Recompute again"
                      : forThis && chain.kind === "error"
                        ? "Retry"
                        : "Recompute from the chain"}
                </Button>
                {forThis && chain.kind === "running" && (
                  <div role="progressbar" aria-valuenow={Math.round(chain.fraction * 100)} aria-valuemin={0} aria-valuemax={100} className="h-3 w-full overflow-hidden rounded-[6px] border-2 border-ink bg-paper">
                    <div className="h-full bg-violet" style={{ width: `${Math.max(2, chain.fraction * 100)}%` }} />
                  </div>
                )}
                {forThis && chain.kind === "error" && (
                  <div role="alert" className="rounded-[8px] border-2 border-ink bg-paper p-3 text-sm leading-6">
                    <p className="font-semibold text-danger-text">{chain.title}</p>
                    <p>{chain.detail}</p>
                    <p className="font-semibold">Nothing was verified, so no result is shown. {chain.retryable ? "Press Retry." : ""}</p>
                  </div>
                )}
              </div>
            )}
          </Panel>

          {rows && forThis && chain.kind === "done" && (
            <Panel
              title="Result"
              pad={false}
              right={
                <span className="num">
                  read {fmtInt(chain.chain.eventCounts.probeResults)} ProbeResult + {fmtInt(chain.chain.eventCounts.penalties)} Penalized events
                </span>
              }
            >
              <div className="border-b-2 border-ink px-3 py-3" role="status">
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
