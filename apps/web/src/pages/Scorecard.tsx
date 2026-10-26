import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { isAddress, type Address, type Hex } from "viem";
import { useAccount, useSignMessage } from "wagmi";
import {
  blockUrl,
  buildReport,
  campaignLabel,
  campaignPath,
  signingMessage,
  withSignature,
  type CampaignView,
  type ScorecardReport,
  type VaultScorecardData,
} from "@plumbline/shared";
import { STATIC, useCampaigns, useMarket, useMarkets, useScorecard } from "../lib/api";
import { fmtAmt, fmtInt, fmtPct, short, tone, toneText } from "../lib/format";
import { MAX_LABEL, useVaultLabels } from "../lib/labels";
import { useLive } from "../lib/liveStore";
import { bodyFromData, downloadText } from "../lib/scorecardReport";
import { WalletButton } from "../components/Layout";
import {
  AddrLink,
  Badge,
  Button,
  Empty,
  ErrorNote,
  Field,
  Input,
  Loading,
  Page,
  PageHeader,
  Panel,
  Stat,
  StatRow,
  Table,
  Td,
  Th,
  TxLink,
  cx,
} from "../components/ui";
import { ApiError } from "../lib/api";

/** Why an address is refused, in words: a wrong checksum is the likely typo, so it gets its own message. */
function addressProblem(s: string): string | null {
  if (isAddress(s)) return null;
  if (/^0x[0-9a-fA-F]{40}$/.test(s)) {
    return "This address has the right shape but its capital letters do not match its checksum. Check it for a typo, or paste it in all lower case.";
  }
  return "Not a valid address: it should be 0x followed by 40 hex characters.";
}

const DISCLOSURE =
  "Probe results are public on-chain. Privacy here means a vault address not tied to your team's identity, and you choose who receives the report. It does not hide on-chain data.";

/** Vaults the data knows about, each linking to its scorecard, with the viewer's own labels. */
function PairVaults({ pair }: { pair: string }) {
  const market = useMarket(pair);
  const { get } = useVaultLabels();
  if (!market.data) return null;
  const { summary: m, book } = market.data;
  return (
    <>
      {book.map((v) => (
        <tr key={v.vault}>
          <Td mono>
            <Link to={`/scorecard/${v.vault}`} className="link">
              {short(v.vault, 6)}
            </Link>
          </Td>
          <Td>
            {m.base.symbol}/{m.quote.symbol}
          </Td>
          <Td>{get(v.vault) ?? <span className="text-muted">no label</span>}</Td>
        </tr>
      ))}
    </>
  );
}

function KnownVaults() {
  const markets = useMarkets();
  const liveState = useLive();
  const chainRead = STATIC && liveState.status !== "error" && liveState.data.views !== null;
  const list = markets.data ?? [];
  return (
    <Panel title={STATIC && !chainRead ? "Vaults in this snapshot" : "Vaults on Elysium"} pad={false}>
      {markets.isLoading ? (
        <Loading rows={3} />
      ) : list.length === 0 ? (
        <Empty>No vaults are listed yet.</Empty>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Vault</Th>
              <Th>Pair</Th>
              <Th>Your label</Th>
            </tr>
          </thead>
          <tbody>
            {list.map((m) => (
              <PairVaults key={m.pair} pair={m.pair} />
            ))}
          </tbody>
        </Table>
      )}
    </Panel>
  );
}

function slashText(s: { campaignId: number; slashed: string }, campaigns: CampaignView[]): string {
  const c = campaigns.find((x) => x.id === s.campaignId);
  return c ? `${fmtAmt(s.slashed, c.rewardDecimals, 3)} ${c.rewardSymbol}` : `${s.slashed} (raw units)`;
}

function LabelEditor({ vault }: { vault: Address }) {
  const { get, set } = useVaultLabels();
  const saved = get(vault) ?? "";
  const [draft, setDraft] = useState(saved);
  useEffect(() => setDraft(saved), [saved, vault]);
  return (
    <Panel title="Your label for this vault" className="no-print">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[14rem] flex-1">
          <Field label="Label" hint="Stored in this browser only. Never sent anywhere or written on-chain.">
            <Input
              value={draft}
              maxLength={MAX_LABEL}
              placeholder="e.g. Our MM"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && set(vault, draft)}
            />
          </Field>
        </div>
        <Button variant="primary" disabled={draft.trim() === saved} onClick={() => set(vault, draft)}>
          Save
        </Button>
        {saved && (
          <Button
            variant="ghost"
            onClick={() => {
              set(vault, "");
              setDraft("");
            }}
          >
            Remove
          </Button>
        )}
      </div>
    </Panel>
  );
}

function ExportPanel({
  data,
  report,
  signed,
  hasLabel,
  includeLabel,
  setIncludeLabel,
  onSigned,
}: {
  data: VaultScorecardData;
  report: ScorecardReport;
  signed: ScorecardReport;
  hasLabel: boolean;
  includeLabel: boolean;
  setIncludeLabel: (v: boolean) => void;
  onSigned: (s: { hash: Hex; signer: Address; signature: Hex }) => void;
}) {
  const { address } = useAccount();
  const { signMessageAsync, isPending, error, reset } = useSignMessage();
  const isOwner = Boolean(address) && address?.toLowerCase() === data.owner.toLowerCase();
  const isSigned = Boolean(signed.signature);

  async function sign() {
    if (!address) return;
    reset();
    try {
      const signature = await signMessageAsync({ message: signingMessage(report.hash) });
      onSigned({ hash: report.hash, signer: address, signature });
    } catch {
      // rejected in the wallet: the error is shown below
    }
  }

  const file = `plumbline-scorecard-${data.base.symbol}-${data.quote.symbol}-${data.vault.slice(2, 10)}-block${data.asOfBlock}.json`;
  return (
    <Panel title="Export this report" className="no-print">
      <div className="space-y-4 text-sm leading-6">
        <p>
          The report holds the figures above, the block they are as of and a hash of both. Anyone can paste it into{" "}
          <Link to="/verify" className="link">
            Verify
          </Link>{" "}
          to recompute every figure from the chain.
        </p>
        {hasLabel && (
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-1 h-4 w-4 accent-violet" checked={includeLabel} onChange={(e) => setIncludeLabel(e.target.checked)} />
            <span>
              Include my label in the file. It is not part of the hash. Off by default, so a report you pass on does not carry your
              team's name for the vault.
            </span>
          </label>
        )}
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => downloadText(file, `${JSON.stringify(signed, null, 2)}\n`)}>
            Download JSON
          </Button>
          <Button onClick={() => window.print()}>Print report</Button>
        </div>

        <div className="rounded-[8px] border-2 border-ink p-3">
          <div className="label text-ink">Owner signature</div>
          {isSigned ? (
            <p className="mt-1.5">
              <Badge tone="pass">signed</Badge> by <AddrLink address={signed.signer ?? ""} n={6} />. The signature is in the file.
            </p>
          ) : (
            <p className="mt-1.5 text-muted">
              Unsigned. A signature proves the vault's owner stands behind this exact report; it costs no gas and sends nothing.
            </p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {address ? (
              <Button disabled={!isOwner || isPending} onClick={() => void sign()}>
                {isPending ? "Check your wallet" : isSigned ? "Sign again" : "Sign with wallet"}
              </Button>
            ) : (
              <WalletButton />
            )}
            {address && !isOwner && (
              <span className="text-xs text-ink">
                Only the vault owner can sign: connect <span className="num">{short(data.owner, 6)}</span>.
              </span>
            )}
          </div>
          {error && <p className="num mt-2 text-xs text-danger-text">Not signed: {error.message.split("\n")[0]}</p>}
          <p className="mt-2 text-xs text-muted">
            The wallet signs the text "Plumbline scorecard v1" and the report hash with personal_sign. It is not a transaction.
          </p>
        </div>
      </div>
    </Panel>
  );
}

/** What prints: figures, history, hash and signature on plain white. Hidden on screen. */
function PrintSheet({ report, campaigns }: { report: ScorecardReport; campaigns: CampaignView[] }) {
  const f = report.body.figures;
  const b = report.body;
  return (
    <div className="print-only">
      <h1 className="font-display text-2xl font-extrabold">Plumbline vault scorecard</h1>
      {report.label && <p className="mt-1 text-lg font-semibold">{report.label}</p>}
      <p className="num mt-2 text-sm">
        {b.pair} · vault {b.vault}
        <br />
        owner {b.owner}
        <br />
        chain {b.chainId} · figures as of block {fmtInt(b.asOfBlock)} · source: {b.source}
      </p>
      <table className="mt-4 w-full text-sm">
        <tbody>
          {[
            ["Uptime (probes passed / probes)", f.uptime === null ? "no probes" : `${fmtPct(f.uptime, 2)} (${f.passes} / ${f.probes})`],
            ["Median spread", f.medianSpreadBps === null ? "none" : `${f.medianSpreadBps} bps`],
            ["Verified bid depth", f.bidDepthQuote === null ? "none" : `${fmtAmt(f.bidDepthQuote, b.quote.decimals, 2)} ${b.quote.symbol}`],
            ["Verified ask depth", f.askDepthBase === null ? "none" : `${fmtAmt(f.askDepthBase, b.base.decimals, 4)} ${b.base.symbol}`],
            ["Slashes", String(f.slashes.length)],
          ].map(([k, v]) => (
            <tr key={k}>
              <td className="py-1 pr-4 font-semibold">{k}</td>
              <td className="num py-1">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {f.slashes.length > 0 && (
        <>
          <h2 className="mt-4 text-base font-bold">Slashes</h2>
          <ul className="num text-sm">
            {f.slashes.map((s) => (
              <li key={s.txHash}>
                campaign {s.campaignId}: {slashText(s, campaigns)} · tx {s.txHash}
              </li>
            ))}
          </ul>
        </>
      )}
      {f.epochs.length > 0 && (
        <>
          <h2 className="mt-4 text-base font-bold">History by epoch</h2>
          <table className="num mt-1 w-full text-sm">
            <thead>
              <tr className="text-left">
                <th>Campaign</th>
                <th>Epoch</th>
                <th>Probes</th>
                <th>Passed</th>
              </tr>
            </thead>
            <tbody>
              {f.epochs.map((e) => (
                <tr key={`${e.campaignId}-${e.epoch}`}>
                  <td>{e.campaignId}</td>
                  <td>{e.epoch}</td>
                  <td>{e.probes}</td>
                  <td>{e.passes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <h2 className="mt-4 text-base font-bold">Integrity</h2>
      <p className="num break-all text-sm">report hash {report.hash}</p>
      {report.signature ? (
        <p className="num break-all text-sm">
          signed by {report.signer} (personal_sign over the hash)
          <br />
          signature {report.signature}
        </p>
      ) : (
        <p className="text-sm">Not signed.</p>
      )}
      <p className="mt-3 text-sm">
        Recompute every figure from on-chain probe logs at the Plumbline Verify page, using the JSON file for this report.
      </p>
      <p className="mt-3 text-xs">{DISCLOSURE}</p>
    </div>
  );
}

function Result({ data }: { data: VaultScorecardData }) {
  const { get } = useVaultLabels();
  const campaigns = useCampaigns().data ?? [];
  const label = get(data.vault);
  const [includeLabel, setIncludeLabel] = useState(false);
  const [sig, setSig] = useState<{ hash: Hex; signer: Address; signature: Hex } | null>(null);

  const body = useMemo(() => bodyFromData(data), [data]);
  const report = useMemo(() => buildReport(body, includeLabel ? label : undefined), [body, includeLabel, label]);
  // A signature belongs to one hash; if the figures ever change, it stops applying.
  const signed = sig && sig.hash === report.hash ? withSignature(report, sig.signer, sig.signature) : report;
  const f = body.figures;
  const none = f.probes === 0;

  return (
    <>
      <div className="no-print space-y-4">
        <StatRow>
          <Stat
            label="Uptime"
            value={fmtPct(f.uptime, 2)}
            tone={tone(f.uptime)}
            sub={none ? "no probes" : `${fmtInt(f.passes)} of ${fmtInt(f.probes)} probes`}
          />
          <Stat label="Probes checked" value={fmtInt(f.probes)} sub={`${f.epochs.length} epoch${f.epochs.length === 1 ? "" : "s"}`} />
          <Stat
            label="Median spread"
            value={f.medianSpreadBps === null ? "—" : `${f.medianSpreadBps} bps`}
            sub={none ? "no probes" : "over passing probes"}
          />
          <Stat
            label="Verified bid depth"
            value={f.bidDepthQuote === null ? "—" : `${fmtAmt(f.bidDepthQuote, data.quote.decimals, 3)} ${data.quote.symbol}`}
            sub="median over passing probes"
          />
          <Stat
            label="Verified ask depth"
            value={f.askDepthBase === null ? "—" : `${fmtAmt(f.askDepthBase, data.base.decimals, 4)} ${data.base.symbol}`}
            sub="median over passing probes"
          />
          <Stat label="Slashes" value={fmtInt(f.slashes.length)} tone={f.slashes.length ? "fail" : "none"} sub="verified failed fills" />
        </StatRow>

        {none && (
          <Panel title="No probes yet">
            <p className="text-sm leading-6">
              No probe has checked this vault{data.campaigns.length === 0 ? " and it is not bonded into any campaign" : ""}, so it has no
              uptime, spread or depth to report. These figures are shown as "—", not as zero.
              {f.slashes.length > 0 ? " It has been slashed, which is listed below." : ""}
            </p>
          </Panel>
        )}

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px] [&>*]:min-w-0">
          <div className="space-y-4">
            <Panel title="History by epoch" pad={false} right={<span>one row per campaign epoch the vault was probed in</span>}>
              {f.epochs.length === 0 ? (
                <Empty>No epoch has probed this vault.</Empty>
              ) : (
                <div className="max-h-[420px] overflow-y-auto">
                  <Table>
                    <thead>
                      <tr>
                        <Th>Campaign</Th>
                        <Th>Epoch</Th>
                        <Th right>Probes</Th>
                        <Th right>Passed</Th>
                        <Th right>Pass rate</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {f.epochs.map((e) => {
                        const rate = e.probes ? e.passes / e.probes : null;
                        return (
                          <tr key={`${e.campaignId}-${e.epoch}`}>
                            <Td mono>
                              <Link to={campaignPath(e.campaignId)} className="link">
                                {campaignLabel(e.campaignId)}
                              </Link>
                            </Td>
                            <Td mono>e{e.epoch}</Td>
                            <Td right mono>
                              {e.probes}
                            </Td>
                            <Td right mono>
                              {e.passes}
                            </Td>
                            <Td right mono className={toneText[tone(rate)]}>
                              {fmtPct(rate, 0)}
                            </Td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </Table>
                </div>
              )}
            </Panel>
            <Panel title="Slashes" pad={false}>
              {f.slashes.length === 0 ? (
                <Empty>No slashes against this vault.</Empty>
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <Th>Campaign</Th>
                      <Th right>Slashed</Th>
                      <Th>Transaction</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {f.slashes.map((s) => (
                      <tr key={s.txHash}>
                        <Td mono>{campaignLabel(s.campaignId)}</Td>
                        <Td right mono className="text-danger-text">
                          {slashText(s, campaigns)}
                        </Td>
                        <Td>
                          <TxLink hash={s.txHash} />
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Panel>
          </div>
          <div className="space-y-4">
            <LabelEditor vault={data.vault} />
            <ExportPanel
              data={data}
              report={report}
              signed={signed}
              hasLabel={Boolean(label)}
              includeLabel={includeLabel}
              setIncludeLabel={setIncludeLabel}
              onSigned={setSig}
            />
          </div>
        </div>
      </div>
      <PrintSheet report={signed} campaigns={campaigns} />
    </>
  );
}

export function ScorecardPage() {
  const { vault: param } = useParams();
  const nav = useNavigate();
  const [input, setInput] = useState(param ?? "");
  useEffect(() => setInput(param ?? ""), [param]);
  const { get } = useVaultLabels();

  const trimmed = input.trim();
  const inputOk = isAddress(trimmed);
  const paramOk = param !== undefined && isAddress(param);
  const q = useScorecard(paramOk ? param : undefined);
  const label = param ? get(param) : undefined;

  const go = () => inputOk && nav(`/scorecard/${trimmed}`);

  return (
    <Page density="dense">
      <div className="no-print">
        <PageHeader
          title={
            <span className="inline-flex flex-wrap items-center gap-3">
              <span>Vault scorecard</span>
              {label && <Badge tone="highlight">{label}</Badge>}
            </span>
          }
          sub="What probes verified about one vault: uptime, spread, depth, slashes and each epoch. Computed from the probe logs, never from a maker's own claims."
        />
      </div>

      <div className="no-print rounded-[8px] border-2 border-ink bg-paper px-4 py-3 text-sm leading-6 shadow-brut">
        <div className="label text-ink">Disclosure</div>
        <p className="mt-1">{DISCLOSURE}</p>
        <p className="mt-2 text-xs text-muted">
          Looking a vault up is a web request: this site's host, which serves a file named by the address, and the RPC nodes that Verify reads from can
          see which address was asked about, as with any web request.
        </p>
      </div>

      <Panel title="Vault address" className="no-print">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            go();
          }}
        >
          <div className="min-w-[16rem] flex-1">
            <Field
              label="Vault"
              hint={trimmed && !inputOk ? addressProblem(trimmed) : "A PlumbQuote vault on Elysium."}
            >
              <Input value={input} onChange={(e) => setInput(e.target.value)} placeholder="0x…" spellCheck={false} autoComplete="off" />
            </Field>
          </div>
          <Button variant="primary" type="submit" disabled={!inputOk}>
            Show scorecard
          </Button>
        </form>
      </Panel>

      {param !== undefined && !paramOk ? (
        <ErrorNote error={`"${param.slice(0, 60)}": ${addressProblem(param) ?? ""}`} />
      ) : param === undefined ? (
        <div className="no-print">
          <KnownVaults />
        </div>
      ) : q.isLoading ? (
        <Loading rows={5} />
      ) : q.isError || !q.data ? (
        q.error instanceof ApiError && q.error.status === 425 ? (
          <Panel title="Reading this vault's history" className="no-print">
            <p className="text-sm leading-6">
              This vault was created after the snapshot. Its probe results are being read from the chain now; this page fills in when that finishes,
              and it never shows a partial history as complete.
            </p>
          </Panel>
        ) : q.error instanceof ApiError && q.error.status === 404 ? (
          <Panel title="No scorecard for this vault" className="no-print">
            <p className="text-sm leading-6">
              {STATIC
                ? "This address is not a Plumbline vault: it is not in the snapshot, and the factory's list of vaults on the chain does not include it."
                : "The indexer does not know this vault. Check the address, or wait for the indexer to catch up."}
            </p>
            <p className="mt-2">
              <Link to="/scorecard" className="link">
                Pick a known vault
              </Link>
            </p>
          </Panel>
        ) : (
          <ErrorNote error={q.error ?? "could not load the scorecard"} />
        )
      ) : (
        <>
          <div className={cx("no-print font-mono text-2xs text-muted")}>
            {q.data.base.symbol}/{q.data.quote.symbol} · vault <AddrLink address={q.data.vault} n={6} /> · owner{" "}
            <AddrLink address={q.data.owner} n={6} /> · figures as of block{" "}
            <a href={blockUrl(q.data.asOfBlock)} target="_blank" rel="noreferrer" className="link">
              {fmtInt(q.data.asOfBlock)}
            </a>
            {q.data.campaigns.length > 0 && (
              <>
                {" "}
                · campaigns{" "}
                {q.data.campaigns.map((id, i) => (
                  <span key={id}>
                    {i > 0 && ", "}
                    <Link to={campaignPath(id)} className="link">
                      {campaignLabel(id)}
                    </Link>
                  </span>
                ))}
              </>
            )}
          </div>
          <Result data={q.data} />
        </>
      )}
    </Page>
  );
}
