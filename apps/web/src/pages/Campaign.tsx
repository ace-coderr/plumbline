import { Link, useParams } from "react-router-dom";
import { useAccount, useWriteContract } from "wagmi";
import { deployment, failLabels, plumbCampaignsAbi } from "@plumbline/shared";
import { useCampaign } from "../lib/api";
import { useNow } from "../components/Snapshot";
import { ago, clock, dateTime, duration, fmtAmt, fmtInt, fmtPct, tone, toneText } from "../lib/format";
import { useTxRunner } from "../lib/tx";
import { EpochBars, ProbeStrip } from "../components/charts";
import { TxStatus } from "../components/TxStatus";
import {
  AddrLink,
  Badge,
  DemoTag,
  Button,
  Empty,
  ErrorNote,
  Loading,
  PageHeader,
  Panel,
  Stat,
  StatRow,
  Table,
  Td,
  Th,
  TxLink,
  Page,
} from "../components/ui";

export function CampaignPage() {
  const { id: idParam = "" } = useParams();
  const id = Number(idParam);
  const q = useCampaign(id);
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const tx = useTxRunner();
  // Snapshot time in static mode, so epochs read as they did when the snapshot was taken.
  const now = useNow();

  if (q.isLoading) return <Loading rows={6} />;
  if (q.isError || !q.data) return <ErrorNote error={q.error ?? "unknown campaign"} />;
  const { campaign: c, leaderboard, epochs, recentProbes, penalties } = q.data;
  const end = c.startTime + c.numEpochs * c.epochLength;
  const settleable = epochs.filter((e) => !e.settled && e.end <= now);
  const reward = (raw: string | null, digits = 4) => (raw === null ? "—" : fmtAmt(raw, c.rewardDecimals, digits));
  const totalPaid = leaderboard.reduce((a, r) => a + BigInt(r.earned), 0n);
  const currentEpoch = epochs[Math.min(c.currentEpoch, epochs.length - 1)];

  async function settle() {
    await tx.run([
      {
        label: `settle epoch ${settleable[0]?.epoch ?? ""}`,
        send: () =>
          writeContractAsync({
            address: deployment.contracts.campaigns,
            abi: plumbCampaignsAbi,
            functionName: "settle",
            args: [BigInt(c.id)],
          }),
      },
    ]);
  }

  return (
    <Page density="dense">
      <PageHeader
        title={
          <span className="inline-flex flex-wrap items-center gap-3">
            <span className="num">
              Campaign #{c.id} · {c.pair}
            </span>
            {(c.quote.demo || c.base.demo) && <DemoTag />}
          </span>
        }
        sub={
          <>
            Sponsored by <AddrLink address={c.creator} /> · opened <TxLink hash={c.openedTx} /> ·{" "}
            {now < end ? `ends ${dateTime(end)}` : `ended ${ago(end, now)}`}
          </>
        }
        right={
          <div className="flex flex-wrap items-center gap-2">
            <Link to={`/report/${c.base.symbol}`}>
              <Button>Depth report</Button>
            </Link>
            <Button variant="primary" disabled={!address || settleable.length === 0 || tx.busy} onClick={() => void settle()}>
              {settleable.length ? `Settle epoch ${settleable[0]?.epoch}` : "Nothing to settle"}
            </Button>
          </div>
        }
      />
      <TxStatus state={tx.state} />

      <StatRow>
        <Stat label="Reward / epoch" value={`${reward(c.rewardPerEpoch, 3)} ${c.rewardSymbol}`} sub={`${c.numEpochs} × ${duration(c.epochLength)}`} />
        <Stat
          label="Epoch"
          value={`${Math.min(c.currentEpoch, c.numEpochs)} / ${c.numEpochs}`}
          sub={currentEpoch && now < end ? `ends in ${duration(Math.max(0, currentEpoch.end - now))}` : `${c.settledEpochs} settled`}
        />
        <Stat label="Probes" value={fmtInt(c.totalProbes)} sub={`last ${ago(c.lastProbeAt, now)}`} />
        <Stat label="Paid to makers" value={`${fmtAmt(totalPaid, c.rewardDecimals, 3)} ${c.rewardSymbol}`} />
        <Stat label="Targets" value={`${c.maxSpreadBps} bps`} sub={`≥ ${fmtAmt(c.minDepthBase, c.base.decimals, 2)} ${c.base.symbol} · ≥ ${fmtAmt(c.minDepthQuote, c.quote.decimals, 0)} ${c.quote.symbol}`} />
        <Stat label="Maker bond" value={`${reward(c.makerBond, 3)} ${c.rewardSymbol}`} sub={`probe fee ${c.probeFeeBps} bps · every ≥${c.minProbeInterval}s`} />
      </StatRow>

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_380px] [&>*]:min-w-0">
        <div className="space-y-4">
          <Panel title="Leaderboard" pad={false} right={<span>points = probes passed</span>}>
            {leaderboard.length === 0 ? (
              <Empty>No makers have bonded in yet.</Empty>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>#</Th>
                    <Th>Vault</Th>
                    <Th>Maker</Th>
                    <Th right>Points</Th>
                    <Th right>Uptime</Th>
                    <Th right>Median spread</Th>
                    <Th right>Earned</Th>
                    <Th right>Bond</Th>
                    <Th right>Slashes</Th>
                    <Th>Status</Th>
                  </tr>
                </thead>
                <tbody>
                  {leaderboard.map((r, i) => (
                    <tr key={r.vault}>
                      <Td mono className="text-muted">
                        {i + 1}
                      </Td>
                      <Td>
                        <AddrLink address={r.vault} />
                      </Td>
                      <Td>
                        <AddrLink address={r.maker} />
                      </Td>
                      <Td right mono className="font-medium">
                        {fmtInt(r.points)}
                        <span className="text-muted">/{fmtInt(r.checks)}</span>
                      </Td>
                      <Td right mono className={toneText[tone(r.uptime)]}>
                        {fmtPct(r.uptime)}
                      </Td>
                      <Td right mono>
                        {r.medianSpreadBps === null ? "—" : `${r.medianSpreadBps} bps`}
                      </Td>
                      <Td right mono className="text-violet">
                        {reward(r.earned)}
                      </Td>
                      <Td right mono className={BigInt(r.bond) < BigInt(c.makerBond) ? "text-danger" : "text-ink"}>
                        {reward(r.bond, 3)}
                      </Td>
                      <Td right mono className={r.penalties ? "text-danger" : "text-muted"}>
                        {r.penalties}
                      </Td>
                      <Td>
                        <Badge tone={r.status === "active" ? "pass" : r.status === "unbonding" ? "warn" : "none"}>{r.status}</Badge>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Panel>

          <Panel title="Epoch history" pad={false}>
            <div className="px-3 pt-3">
              <EpochBars data={epochs.map((e) => ({ epoch: e.epoch, probes: e.probes, points: e.totalPoints }))} />
            </div>
            <Table>
              <thead>
                <tr>
                  <Th>Epoch</Th>
                  <Th>Window</Th>
                  <Th right>Probes</Th>
                  <Th right>Points</Th>
                  <Th right>Maker pot</Th>
                  <Th right>Refunded</Th>
                  <Th>Settled</Th>
                </tr>
              </thead>
              <tbody>
                {epochs.map((e) => (
                  <tr key={e.epoch} className={e.start > now ? "opacity-40" : undefined}>
                    <Td mono>e{e.epoch}</Td>
                    <Td mono className="text-muted">
                      {clock(e.start)}–{clock(e.end)}
                    </Td>
                    <Td right mono>
                      {e.probes}
                    </Td>
                    <Td right mono>
                      {e.totalPoints}
                    </Td>
                    <Td right mono className="text-violet">
                      {reward(e.makerPot)}
                    </Td>
                    <Td right mono className="text-muted">
                      {reward(e.refunded)}
                    </Td>
                    <Td>
                      {e.settled && e.settledTx ? (
                        <TxLink hash={e.settledTx}>settled</TxLink>
                      ) : e.end <= now ? (
                        <Badge tone="warn">due</Badge>
                      ) : e.start <= now ? (
                        <Badge tone="pass">running</Badge>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Panel>
        </div>

        <div className="space-y-4">
          <Panel title="Recent probes">
            <ProbeStrip probes={recentProbes} max={60} />
            <div className="mt-3 max-h-[420px] space-y-0 overflow-y-auto">
              {recentProbes.slice(0, 30).map((p) => (
                <div key={p.nonce} className="flex items-center justify-between border-b border-ink py-1.5 font-mono text-2xs">
                  <span className="text-muted">
                    #{p.nonce} {clock(p.ts)}
                  </span>
                  <span className={p.passed === p.checked && p.checked > 0 ? "text-success" : p.passed > 0 ? "text-ink" : "text-danger"}>
                    {p.passed}/{p.checked}
                  </span>
                  <span className="w-28 truncate text-muted" title={p.results.map((r) => failLabels(r.failMask).join(",")).join(" ")}>
                    {p.results
                      .filter((r) => !r.passed)
                      .map((r) => failLabels(r.failMask).join("+"))
                      .join(" ") || "clean"}
                  </span>
                  <TxLink hash={p.txHash} />
                </div>
              ))}
            </div>
          </Panel>
          <Panel title="Penalties">
            {penalties.length === 0 ? (
              <Empty>No bonds slashed.</Empty>
            ) : (
              penalties.map((p) => (
                <div key={p.txHash + p.vault} className="flex items-center justify-between border-b border-ink py-1.5 font-mono text-2xs">
                  <AddrLink address={p.vault} />
                  <span className="text-danger">−{reward(p.slashed)}</span>
                  <TxLink hash={p.txHash} />
                </div>
              ))
            )}
          </Panel>
        </div>
      </div>
    </Page>
  );
}
