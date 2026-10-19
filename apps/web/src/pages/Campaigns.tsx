import { Link } from "react-router-dom";
import { useCampaigns } from "../lib/api";
import { ago, duration, fmtAmt, fmtInt } from "../lib/format";
import { Badge, Button, DemoTag, Empty, ErrorNote, Loading, PageHeader, Panel, Table, Td, Th, Page } from "../components/ui";

export function CampaignsPage() {
  const q = useCampaigns();
  const now = Math.floor(Date.now() / 1000);
  return (
    <Page density="dense">
      <PageHeader
        title="Campaigns"
        sub="Sponsors fund an epoch pot; probes decide who earns it."
        right={
          <Link to="/campaigns/new">
            <Button variant="primary">Open a campaign</Button>
          </Link>
        }
      />
      <Panel pad={false} title="All campaigns">
        {q.isLoading ? (
          <div className="p-3">
            <Loading />
          </div>
        ) : q.isError ? (
          <div className="p-3">
            <ErrorNote error={q.error} />
          </div>
        ) : !q.data?.length ? (
          <Empty>No campaigns yet.</Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Id</Th>
                <Th>Pair</Th>
                <Th>Status</Th>
                <Th right>Reward / epoch</Th>
                <Th right>Epoch</Th>
                <Th right>Progress</Th>
                <Th right>Max spread</Th>
                <Th right>Min depth</Th>
                <Th right>Probes</Th>
                <Th>Last probe</Th>
              </tr>
            </thead>
            <tbody>
              {q.data.map((c) => {
                const end = c.startTime + c.numEpochs * c.epochLength;
                const status = now < c.startTime ? "scheduled" : now < end ? "live" : c.settledEpochs < c.numEpochs ? "settling" : "done";
                return (
                  <tr key={c.id} className="hover:bg-highlight/40">
                    <Td mono>
                      <Link to={`/campaign/${c.id}`} className="link">
                        #{c.id}
                      </Link>
                    </Td>
                    <Td mono>
                      <span className="inline-flex items-center gap-2">
                        {c.pair}
                        {(c.quote.demo || c.base.demo) && <DemoTag />}
                      </span>
                    </Td>
                    <Td>
                      <Badge tone={status === "live" ? "pass" : status === "settling" ? "warn" : "none"}>{status}</Badge>
                    </Td>
                    <Td right mono>
                      {fmtAmt(c.rewardPerEpoch, c.rewardDecimals, 3)} <span className="text-muted">{c.rewardSymbol}</span>
                    </Td>
                    <Td right mono>
                      {duration(c.epochLength)}
                    </Td>
                    <Td right mono>
                      {Math.min(c.currentEpoch, c.numEpochs)}/{c.numEpochs} <span className="text-muted">· {c.settledEpochs} settled</span>
                    </Td>
                    <Td right mono>
                      {c.maxSpreadBps} bps
                    </Td>
                    <Td right mono className="text-ink">
                      {fmtAmt(c.minDepthBase, c.base.decimals, 2)} {c.base.symbol} / {fmtAmt(c.minDepthQuote, c.quote.decimals, 0)}{" "}
                      {c.quote.symbol}
                    </Td>
                    <Td right mono>
                      {fmtInt(c.totalProbes)}
                    </Td>
                    <Td mono className="text-muted">
                      {ago(c.lastProbeAt, now)}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Panel>
    </Page>
  );
}
