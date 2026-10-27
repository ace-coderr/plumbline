import { useQuery } from "@tanstack/react-query";
import { createPublicClient, http } from "viem";
import { Link } from "react-router-dom";
import { blockUrl, elysiumTestnet, historyComplete, lagosLabel, nextWindow, runnerHeartbeat, utcLabel, windowAt } from "@plumbline/shared";
import { botsSchedule as sched } from "../lib/schedule";
import { STATIC, useSnapshot } from "../lib/api";
import { RPC_URLS } from "../lib/chain";
import { useLive } from "../lib/liveStore";
import { dateTime, fmtInt, short } from "../lib/format";
import { useNow } from "../components/Snapshot";
import { AddrLink, Badge, Page, PageHeader, Panel, Table, Td, Th } from "../components/ui";
import { TreasuryPanel } from "../components/TreasuryPanel";

interface RpcRow {
  url: string;
  ok: boolean;
  block: number | null;
  ms: number | null;
  error: string | null;
}

/** Ask each node on its own, so one dead node shows as dead instead of being hidden by the fallback. */
async function checkNodes(): Promise<RpcRow[]> {
  return Promise.all(
    RPC_URLS.map(async (url): Promise<RpcRow> => {
      const client = createPublicClient({ chain: elysiumTestnet, transport: http(url, { timeout: 8_000, retryCount: 0 }) });
      const t0 = performance.now();
      try {
        const block = Number(await client.getBlockNumber());
        return { url, ok: true, block, ms: Math.round(performance.now() - t0), error: null };
      } catch (err) {
        const msg = err instanceof Error ? (err.message.split("\n")[0] ?? "failed") : "failed";
        return { url, ok: false, block: null, ms: null, error: msg };
      }
    }),
  );
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

const utc = (ts: number): string => dateTime(ts).replace("Z", " UTC");

function age(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86_400)}d ${Math.floor((s % 86_400) / 3600)}h`;
}

export function StatusPage() {
  const live = useLive();
  const meta = useSnapshot();
  const now = useNow();
  const nodes = useQuery({ queryKey: ["status-nodes"], queryFn: checkNodes, refetchInterval: 15_000, retry: false });
  const views = live.data.views;
  const snap = live.snapshot ?? (meta.data ? { block: meta.data.block, blockTimestamp: meta.data.blockTimestamp } : null);

  const quoteAges = (views?.vaults ?? [])
    .map((v) => ({ v, sec: v.quoteData.updatedAt > 0 ? now - v.quoteData.updatedAt : null }))
    .sort((a, b) => (a.sec ?? Infinity) - (b.sec ?? Infinity));
  const newestQuote = quoteAges.find((x) => x.sec !== null)?.sec ?? null;
  const campaigns = views?.campaigns ?? [];
  const lastProbeAt = campaigns.reduce((m, c) => Math.max(m, c.state.lastProbeAt), 0);
  const running = campaigns.filter((c) => now >= c.state.startTime && now < c.state.startTime + c.state.numEpochs * c.terms.epochLength);
  const okNodes = (nodes.data ?? []).filter((n) => n.ok);
  const complete = historyComplete(live.data);
  const runnerOn = sched.enabled && sched.windows.length > 0;
  const cur = windowAt(sched, now);
  const inWindow = cur !== null;
  const nxt = nextWindow(sched, now);
  const probes = live.data.events
    .filter((e) => e.name === "Probed" && typeof e.args.prober === "string")
    .map((e) => ({ prober: String(e.args.prober), ts: live.data.blockTimes[e.block] ?? 0 }));
  const beat = views ? runnerHeartbeat(sched, views.vaults, probes) : null;

  const readState =
    live.status === "live" ? "reading the chain" : live.status === "syncing" ? "reading the chain (still scanning history)" : live.status === "error" ? "cannot read the chain" : "starting";

  return (
    <Page density="expressive">
      <PageHeader
        kicker="Everything here is read from the chain just now"
        title="Status"
        sub="Block height, node health, and how recently the bots have acted, worked out in this browser from the Elysium nodes. Nothing on this page is typed in."
      />

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <Panel
          title="Chain and nodes"
          right={nodes.data ? <Badge tone={okNodes.length === nodes.data.length ? "pass" : okNodes.length > 0 ? "warn" : "fail"}>{okNodes.length}/{nodes.data.length} nodes up</Badge> : undefined}
        >
          {views && (
            <p className="mb-3 text-sm">
              Latest block read by the page:{" "}
              <a className="num font-semibold underline decoration-2 underline-offset-2" href={blockUrl(views.head)} target="_blank" rel="noreferrer">
                #{fmtInt(views.head)}
              </a>{" "}
              <span className="text-muted">({utc(views.headTs)})</span>
            </p>
          )}
          {nodes.isLoading ? (
            <p className="text-sm text-muted">Asking each node…</p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Node</Th>
                  <Th>State</Th>
                  <Th right>Block</Th>
                  <Th right>Answered in</Th>
                </tr>
              </thead>
              <tbody>
                {(nodes.data ?? []).map((n) => (
                  <tr key={n.url}>
                    <Td>
                      <span className="num">{hostOf(n.url)}</span>
                    </Td>
                    <Td>{n.ok ? <Badge tone="pass">up</Badge> : <Badge tone="fail">down</Badge>}</Td>
                    <Td right>
                      <span className="num">{n.block !== null ? fmtInt(n.block) : "—"}</span>
                    </Td>
                    <Td right>
                      <span className="num">{n.ms !== null ? `${n.ms} ms` : (n.error ?? "—")}</span>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          {nodes.isError && <p className="mt-2 text-sm">The node check itself failed. It will retry.</p>}
          <p className="mt-3 text-xs text-muted">Each node is asked separately every 15 seconds; the rest of the site uses them in this order and moves to the next on a failure.</p>
        </Panel>

        <Panel title="Bots and probes, from on-chain timestamps">
          {views === null ? (
            <p className="text-sm text-muted">{live.status === "error" ? "The chain cannot be read right now, so nothing is shown rather than a guess." : "Reading the chain…"}</p>
          ) : (
            <dl className="space-y-2.5 text-sm">
              {[
                ["Newest quote update (maker bot last seen)", newestQuote === null ? "no vault has ever quoted" : `${age(newestQuote)} ago`],
                ["Vaults quoting now", `${views.vaults.filter((v) => v.live).length} of ${views.vaultCount}`],
                ["Last probe (by anyone, keeper last seen)", lastProbeAt === 0 ? "none recorded" : `${age(now - lastProbeAt)} ago (${utc(lastProbeAt)})`],
                ["Campaigns running", `${running.length} of ${views.campaignCount}`],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3">
                  <dt className="text-muted">{k}</dt>
                  <dd className="num text-right font-semibold text-ink">{v}</dd>
                </div>
              ))}
            </dl>
          )}
          <p className="mt-3 text-xs leading-5 text-muted">
            A bot has no heartbeat of its own on-chain, so "last seen" is the latest thing it can only have caused: the newest quote written to a vault, and the
            newest probe. If either is old, the bot behind it is not running.
          </p>
        </Panel>
      </div>

      <Panel title="Automated runner" className="mt-6" right={<Badge tone={runnerOn ? "pass" : "none"}>{runnerOn ? (inWindow ? "window open" : "scheduled") : "not scheduled"}</Badge>}>
        {!runnerOn ? (
          <p className="text-sm leading-6">
            <strong>Nothing is scheduled.</strong> {sched.enabled ? "The schedule is switched on but has no windows." : "In bots.schedule.json the schedule is switched off."} Any bots
            running now were started by hand.
          </p>
        ) : (
          <dl className="space-y-2.5 text-sm">
            {[
              ["Windows, every day", sched.windows.map((w) => `${w.startUtc} UTC for ${w.minutes} min`).join(" · ")],
              ["Daily spend cap", `${sched.dailyHypeCap} HYPE`],
              [inWindow ? "Window open until" : "Next window", inWindow && cur ? `${utcLabel(cur.end)} · ${lagosLabel(cur.end)}` : nxt ? `${utcLabel(nxt.start)} · ${lagosLabel(nxt.start)}` : "none"],
            ].map(([k, v]) => (
              <div key={k} className="flex flex-wrap justify-between gap-x-3">
                <dt className="text-muted">{k}</dt>
                <dd className="num text-right font-semibold text-ink">{v}</dd>
              </div>
            ))}
          </dl>
        )}
        <p className="mt-3 text-sm leading-6">
          <span className="text-muted">Last heartbeat on-chain: </span>
          {views === null ? (
            <span>not readable right now</span>
          ) : beat ? (
            <span className="num font-semibold">
              {age(now - beat.at)} ago ({utcLabel(beat.at)}), {beat.what}
            </span>
          ) : (
            <span className="font-semibold">none seen: no runner wallet has written a quote or sent a probe</span>
          )}
        </p>
        <p className="mt-2 text-xs leading-5 text-muted">
          The schedule is read from the same file the runner is deployed from. The heartbeat is the newest quote written to the two runner vaults by their listed
          quoters or probe sent by the keeper wallet, read from the chain. It shows what the wallets did, not whether the host is up.
        </p>
      </Panel>

      <TreasuryPanel />

      <Panel title="Quote age per vault" className="mt-6" pad={false}>
        {views === null ? (
          <p className="p-5 text-sm text-muted">{live.status === "error" ? "Not readable right now." : "Reading the chain…"}</p>
        ) : quoteAges.length === 0 ? (
          <p className="p-5 text-sm">No vaults exist yet.</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Vault</Th>
                <Th>Owner</Th>
                <Th>Quote</Th>
                <Th right>Last updated</Th>
                <Th right>Updates</Th>
              </tr>
            </thead>
            <tbody>
              {quoteAges.map(({ v, sec }) => (
                <tr key={v.address}>
                  <Td>
                    <Link className="link num" to={`/scorecard/${v.address}`}>
                      {short(v.address, 5)}
                    </Link>
                  </Td>
                  <Td>
                    <AddrLink address={v.owner} />
                  </Td>
                  <Td>{v.live ? <Badge tone="pass">fresh</Badge> : <Badge tone="warn">stale</Badge>}</Td>
                  <Td right>
                    <span className="num">{sec === null ? (v.quoteData.seq > 0 ? "quote cancelled" : "never quoted") : `${age(sec)} ago`}</span>
                  </Td>
                  <Td right>
                    <span className="num">{fmtInt(v.quoteData.seq)}</span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>

      {STATIC && (
        <Panel title="Live and snapshot, side by side" className="mt-6" pad={false}>
          <Table>
            <thead>
              <tr>
                <Th>What</Th>
                <Th>Where it comes from</Th>
                <Th>As of</Th>
              </tr>
            </thead>
            <tbody>
              {[
                ["Latest block, node health", "live", views ? `block ${fmtInt(views.head)}, ${utc(views.headTs)}` : "not readable yet"],
                ["Campaign terms and state", "live", views ? `block ${fmtInt(views.head)}` : "not readable yet"],
                ["Vaults, balances, current quotes", "live", views ? `block ${fmtInt(views.head)}` : "not readable yet"],
                [
                  "Probes, slashes, settlements, bonds, rewards: scores, uptime, timelines, spread and depth medians",
                  complete ? "live" : "snapshot",
                  complete
                    ? `${fmtInt(live.data.events.length)} events from block ${fmtInt(live.data.historyFrom)} through ${fmtInt(live.data.scannedThrough)}`
                    : live.data.scannedThrough > 0
                      ? `events read through block ${fmtInt(live.data.scannedThrough)}${live.data.scanComplete ? "" : " (scan in progress)"}; until the history is complete these are the snapshot's plus what came after it`
                      : "not scanned yet",
                ],
                [
                  "Fills and failed fills after the snapshot block",
                  "live",
                  live.data.scanComplete ? `read through block ${fmtInt(live.data.scannedThrough)}` : "scan in progress",
                ],
                ["Fills before the snapshot block", "snapshot", snap ? `block ${fmtInt(snap.block)}, ${utc(snap.blockTimestamp)}` : "unknown"],
                [
                  "Gas per probe and per quote update, probe spend, gas price, HYPE price, per-hour quote rates",
                  "snapshot",
                  snap ? `block ${fmtInt(snap.block)}, ${utc(snap.blockTimestamp)}` : "unknown",
                ],
              ].map(([what, from, asOf]) => (
                <tr key={what}>
                  <Td>{what}</Td>
                  <Td>{from === "live" ? <Badge tone="pass">live from chain</Badge> : <Badge tone="warn">snapshot</Badge>}</Td>
                  <Td>
                    <span className="num">{asOf}</span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Panel>
      )}
      <p className="mt-4 text-xs text-muted">Reader state: {readState}.</p>
    </Page>
  );
}
