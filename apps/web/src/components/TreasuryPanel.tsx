import { useQuery } from "@tanstack/react-query";
import { createPublicClient, erc20Abi, fallback, http, formatEther, type Address } from "viem";
import { ELYSIUM_TESTNET, RUNNER_WALLETS, deployment, elysiumTestnet, faucetDeployment, txUrl, type RunnerWallet } from "@plumbline/shared";
import { botsSchedule as sched } from "../lib/schedule";
import { RPC_URLS } from "../lib/chain";
import { fmtInt } from "../lib/format";
import { AddrLink, Badge, Panel, Table, Td, Th } from "./ui";

const client = createPublicClient({ chain: elysiumTestnet, transport: fallback(RPC_URLS.map((u) => http(u, { timeout: 8_000, retryCount: 0 }))) });

interface TopUpTx {
  hash: string;
  to: string;
  valueWei: bigint;
  at: number;
}

interface Funding {
  treasuryWei: bigint;
  wallets: { wallet: RunnerWallet; address: Address; wei: bigint }[];
  last: TopUpTx | null;
  /** Whole PLUMBUSD at the faucet pool and the sponsor wallet; null when unreadable or not set. */
  plumbusd: { faucet: number | null; sponsor: number | null };
}

const PLUMBUSD = (deployment.demoTokens as Record<string, { address: Address; decimals: number }>).PLUMBUSD as { address: Address; decimals: number };

async function plumbusdOf(who: Address | null | undefined): Promise<number | null> {
  if (!who) return null;
  try {
    const raw = await client.readContract({ address: PLUMBUSD.address, abi: erc20Abi, functionName: "balanceOf", args: [who] });
    return Number(raw) / 10 ** PLUMBUSD.decimals;
  } catch {
    return null;
  }
}

const hype = (wei: bigint, digits = 4): string => Number(formatEther(wei)).toFixed(digits);

/** The newest successful transfer from the treasury to a wallet the schedule lists, from the explorer's index of the chain. */
async function lastTopUp(treasury: Address): Promise<TopUpTx | null> {
  const listed = new Set(RUNNER_WALLETS.map((w) => sched.wallets[w]?.toLowerCase()).filter(Boolean));
  const res = await fetch(`${ELYSIUM_TESTNET.explorerApiUrl}?module=account&action=txlist&address=${treasury}&sort=desc&page=1&offset=50`);
  const body = (await res.json()) as { result: unknown };
  if (!Array.isArray(body.result)) return null;
  for (const t of body.result as { from: string; to: string; hash: string; value: string; timeStamp: string; isError: string }[]) {
    if (t.from.toLowerCase() === treasury.toLowerCase() && listed.has(t.to.toLowerCase()) && t.isError === "0" && BigInt(t.value) > 0n) {
      return { hash: t.hash, to: t.to, valueWei: BigInt(t.value), at: Number(t.timeStamp) };
    }
  }
  return null;
}

async function readFunding(treasury: Address): Promise<Funding> {
  const wallets = RUNNER_WALLETS.flatMap((wallet) => (sched.wallets[wallet] ? [{ wallet, address: sched.wallets[wallet] as Address }] : []));
  const [treasuryWei, ...rest] = await Promise.all([client.getBalance({ address: treasury }), ...wallets.map((w) => client.getBalance({ address: w.address }))]);
  const last = await lastTopUp(treasury).catch(() => null);
  const [faucet, sponsor] = await Promise.all([plumbusdOf(faucetDeployment?.address), plumbusdOf(sched.wallets.sponsor)]);
  return { treasuryWei, wallets: wallets.map((w, i) => ({ ...w, wei: rest[i] as bigint })), last, plumbusd: { faucet, sponsor } };
}

/** Days of the measured daily spend a wallet still holds above its floor. */
const daysOf = (wallet: RunnerWallet, wei: bigint): number => Math.max(0, (Number(formatEther(wei)) - sched.floorHype[wallet]) / sched.topUp.dailySpendHype[wallet]);

const ago = (sec: number): string => {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - sec));
  return s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86_400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86_400)} d ago`;
};

/** The treasury and how many days each bot wallet can still run, all read from the chain just now. */
export function TreasuryPanel() {
  const treasury = sched.treasury.address;
  const q = useQuery({ queryKey: ["status-funding", treasury], queryFn: () => readFunding(treasury as Address), enabled: treasury !== null, refetchInterval: 30_000, retry: false });
  const low = q.data ? q.data.treasuryWei < BigInt(Math.round(sched.treasury.lowAlertHype * 1e9)) * 1_000_000_000n : false;

  if (treasury === null) {
    return (
      <Panel title="Treasury and funding" className="mt-6">
        <p className="text-sm leading-6">
          <strong>No treasury is set.</strong> The bot wallets are not topped up automatically.
        </p>
      </Panel>
    );
  }
  return (
    <Panel
      title="Treasury and funding"
      className="mt-6"
      right={q.data ? <Badge tone={low ? "warn" : "pass"}>{low ? "treasury low" : "treasury ok"}</Badge> : undefined}
    >
      {q.isLoading ? (
        <p className="text-sm text-muted">Reading the balances…</p>
      ) : q.isError || !q.data ? (
        <p className="text-sm">The balances cannot be read right now, so nothing is shown rather than a guess. It will retry.</p>
      ) : (
        <>
          {low && (
            <p className="mb-3 border-2 border-ink bg-highlight p-3 text-sm font-semibold">
              The treasury holds {hype(q.data.treasuryWei)} HYPE, under {sched.treasury.lowAlertHype}. Automatic top-ups stop below {sched.treasury.minHype} HYPE.
            </p>
          )}
          <dl className="space-y-2.5 text-sm">
            <div className="flex flex-wrap justify-between gap-x-3">
              <dt className="text-muted">Treasury</dt>
              <dd className="num text-right font-semibold text-ink">
                {hype(q.data.treasuryWei)} HYPE · <AddrLink address={treasury} />
              </dd>
            </div>
            <div className="flex flex-wrap justify-between gap-x-3">
              <dt className="text-muted">Last top-up</dt>
              <dd className="num text-right font-semibold text-ink">
                {q.data.last ? (
                  <a className="underline decoration-2 underline-offset-2" href={txUrl(q.data.last.hash)} target="_blank" rel="noreferrer">
                    {hype(q.data.last.valueWei, 5)} HYPE, {ago(q.data.last.at)}
                  </a>
                ) : (
                  "none yet"
                )}
              </dd>
            </div>
            {([
              ["Faucet pool (PLUMBUSD)", q.data.plumbusd.faucet, sched.alerts.faucetLowPlumbusd],
              ["Sponsor wallet (PLUMBUSD)", q.data.plumbusd.sponsor, sched.alerts.sponsorLowPlumbusd],
            ] as const).map(([k, v, lowAt]) => (
              <div key={k} className="flex flex-wrap justify-between gap-x-3">
                <dt className="text-muted">{k}</dt>
                <dd className="num text-right font-semibold text-ink">
                  {v === null ? "not readable right now" : fmtInt(Math.floor(v))} {v !== null && v < lowAt ? <Badge tone="warn">under {fmtInt(lowAt)}</Badge> : null}
                </dd>
              </div>
            ))}
            <div className="flex flex-wrap justify-between gap-x-3">
              <dt className="text-muted">Rule</dt>
              <dd className="text-right">
                {sched.topUp.enabled
                  ? `below ${sched.topUp.belowDays} days → fill to ${sched.topUp.toDays} days, checked every ${sched.topUp.checkEveryMinutes} min in a window`
                  : "automatic top-ups are switched off"}
              </dd>
            </div>
          </dl>
          <div className="mt-4">
            <Table>
              <thead>
                <tr>
                  <Th>Wallet</Th>
                  <Th right>Balance</Th>
                  <Th right>Days of funding left</Th>
                </tr>
              </thead>
              <tbody>
                {q.data.wallets.map((w) => {
                  const d = daysOf(w.wallet, w.wei);
                  return (
                    <tr key={w.wallet}>
                      <Td>
                        {w.wallet} · <AddrLink address={w.address} />
                      </Td>
                      <Td right>
                        <span className="num">{hype(w.wei, 5)}</span>
                      </Td>
                      <Td right>
                        <span className="num">
                          {d.toFixed(1)} {d < sched.topUp.belowDays ? <Badge tone="warn">low</Badge> : null}
                        </span>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </div>
        </>
      )}
      <p className="mt-3 text-xs leading-5 text-muted">
        Balances are read from the chain. Days left is the balance above the wallet's floor divided by its measured daily spend in bots.schedule.json. The treasury can send
        only to the wallets that file lists.
      </p>
    </Panel>
  );
}
