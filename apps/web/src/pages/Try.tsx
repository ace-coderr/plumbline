import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { decodeEventLog, formatEther, zeroAddress, type Address } from "viem";
import { useAccount, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import {
  ELYSIUM_TESTNET,
  MEASURED_GAS,
  REPO_URL,
  deployment,
  elysiumTestnet,
  knownTokens,
  plumbCampaignsAbi,
  plumbQuoteFactoryAbi,
  campaignLabel,
  resolveCampaign,
} from "@plumbline/shared";
import { wagmiConfig } from "../lib/wagmi";
import { useLive } from "../lib/liveStore";
import { useTxRunner } from "../lib/tx";
import { duration, fmtDec } from "../lib/format";
import { useNow } from "../components/Snapshot";
import { TxStatus } from "../components/TxStatus";
import { GasCost } from "../components/Write";
import { AddrLink, Button, Page, PageHeader, Panel, TxLink } from "../components/ui";
import { chainClient } from "../lib/chain";

function Step({ n, title, done, children }: { n: number; title: string; done?: boolean; children: ReactNode }) {
  return (
    <li className="rounded-card border-2 border-ink bg-paper p-4 shadow-brut sm:p-5">
      <div className="flex items-start gap-3">
        <span
          className={`num grid h-8 w-8 shrink-0 place-items-center rounded-full border-2 border-ink text-sm font-bold ${done ? "bg-success-text text-paper" : "bg-bg text-ink"}`}
          aria-label={done ? `step ${n}, done` : `step ${n}`}
        >
          {done ? "✓" : n}
        </span>
        <div className="min-w-0 flex-1 space-y-2 text-sm leading-6">
          <h2 className="font-display text-lg font-extrabold tracking-display">{title}</h2>
          {children}
        </div>
      </div>
    </li>
  );
}

/** What a failed probe means to a person. */
function friendly(message: string): string {
  if (/reject|denied|cancel/i.test(message)) return "You declined the request in your wallet, so nothing was sent.";
  if (/GateClosed/i.test(message)) return "The gate closed before the transaction landed. Nothing was spent beyond gas; try again when it opens.";
  return message;
}

export function TryPage() {
  const { address, chainId, isConnected } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const live = useLive();
  const now = useNow();
  const tx = useTxRunner();
  const probeTx = useTxRunner();
  const tokens = knownTokens();
  const [created, setCreated] = useState<{ vault: Address; hash: `0x${string}` } | null>(null);
  const [campaignId, setCampaignId] = useState<number | null>(null);
  const wrongNetwork = isConnected && chainId !== elysiumTestnet.id;

  const hype = useQuery({
    queryKey: ["try-hype", address ?? null],
    enabled: Boolean(address),
    refetchInterval: 15_000,
    queryFn: () => chainClient.getBalance({ address: address as Address }),
  });

  const views = live.status !== "error" ? live.data.views : null;
  const running = (views?.campaigns ?? []).filter((c) => now >= c.state.startTime && now < c.state.startTime + c.state.numEpochs * c.terms.epochLength);
  const mine = (views?.vaults ?? []).filter((v) => address && v.owner.toLowerCase() === address.toLowerCase());
  const target = running.find((c) => c.id === campaignId) ?? running[0] ?? null;

  const gate = useQuery({
    queryKey: ["try-gate", target?.id ?? null],
    enabled: target !== null,
    refetchInterval: 4_000,
    queryFn: async () => ({
      open: await chainClient.readContract({
        address: resolveCampaign(target?.id ?? 0).source.campaigns,
        abi: plumbCampaignsAbi,
        functionName: "probeGateOpen",
        args: [BigInt(resolveCampaign(target?.id ?? 0).localId)],
      }),
      block: await chainClient.getBlockNumber(),
    }),
  });

  const hasGas = (hype.data ?? 0n) >= 50_000_000_000_000n;
  const base = tokens.find((t) => t.symbol === "WHYPE");
  const quote = tokens.find((t) => t.symbol === "PLUMBUSD");

  async function createVault() {
    if (!base || !quote) return;
    let hash: `0x${string}` | null = null;
    const ok = await tx.run([
      {
        label: "create vault",
        send: async () => {
          hash = await writeContractAsync({
            address: deployment.contracts.factory,
            abi: plumbQuoteFactoryAbi,
            functionName: "createVault",
            args: [base.address as Address, quote.address as Address, zeroAddress],
          });
          return hash;
        },
      },
    ]);
    if (!ok || !hash) return;
    const h: `0x${string}` = hash;
    const receipt = await waitForTransactionReceipt(wagmiConfig, { hash: h });
    for (const l of receipt.logs) {
      try {
        const e = decodeEventLog({ abi: plumbQuoteFactoryAbi, data: l.data, topics: l.topics });
        if (e.eventName === "VaultCreated") setCreated({ vault: e.args.vault, hash: h });
      } catch {
        // not a factory event
      }
    }
  }

  async function runProbe() {
    if (!target) return;
    // Ask the chain again right before sending: the gate is open for only a moment.
    const open = await chainClient.readContract({
      address: resolveCampaign(target.id).source.campaigns,
      abi: plumbCampaignsAbi,
      functionName: "probeGateOpen",
      args: [BigInt(resolveCampaign(target.id).localId)],
    });
    await gate.refetch();
    if (!open) return;
    await probeTx.run([
      {
        label: `probe campaign ${campaignLabel(target.id)}`,
        send: () =>
          writeContractAsync({
            address: resolveCampaign(target.id).source.campaigns,
            abi: plumbCampaignsAbi,
            functionName: "probe",
            args: [BigInt(resolveCampaign(target.id).localId)],
          }),
      },
    ]);
  }

  const gateKnown = gate.data !== undefined;

  return (
    <Page density="expressive">
      <PageHeader
        kicker="Hands on"
        title="Try it"
        sub="Six steps from an empty wallet to a probe. Every step is a real testnet transaction; none of it costs anything of value."
      />
      <ol className="mt-8 space-y-4">
        <Step n={1} title="Get testnet HYPE for gas" done={Boolean(address) && hasGas}>
          <p>
            Every transaction needs a little HYPE. The official Elysium faucet hands it out:{" "}
            <a className="link font-semibold" href={ELYSIUM_TESTNET.faucetUrl} target="_blank" rel="noreferrer">
              Elysium testnet faucet
            </a>
            .{" "}
            {address && hype.data !== undefined && (
              <span className="num">
                Your wallet holds {fmtDec(Number(formatEther(hype.data)), 5)} HYPE.
              </span>
            )}
          </p>
          {isConnected && wrongNetwork && (
            <p className="font-semibold text-danger-text">
              Your wallet is on another network. Switch it to {elysiumTestnet.name} (chain {elysiumTestnet.id}) with the wallet button at the top.
            </p>
          )}
          {!isConnected && <p className="text-muted">Connect a wallet with the button at the top right to follow along.</p>}
        </Step>

        <Step n={2} title="Get demo PLUMBUSD">
          <p>
            The <Link className="link font-semibold" to="/faucet">faucet</Link> sends 100 PLUMBUSD to your address once a day. PLUMBUSD is a demo asset with no
            value; it is the quote side of the demo market.
          </p>
        </Step>

        <Step n={3} title="Create a vault" done={mine.length > 0 || created !== null}>
          <p>
            A vault is a contract that holds your inventory and posts your quote. This creates an empty WHYPE/PLUMBUSD vault owned by your wallet, in one
            transaction.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" disabled={!address || wrongNetwork || tx.busy || !base || !quote} onClick={() => void createVault()}>
              {address ? "Create a vault" : "Connect a wallet"}
            </Button>
            <GasCost gas={MEASURED_GAS.createVault} label="costs" />
          </div>
          <TxStatus state={tx.state} />
          {created && (
            <p className="rounded-[8px] border-2 border-ink bg-highlight px-3 py-2">
              Vault <AddrLink address={created.vault} n={6} /> created in <TxLink hash={created.hash} />. Its scorecard is at{" "}
              <Link className="link" to={`/scorecard/${created.vault}`}>
                /scorecard/{created.vault.slice(0, 8)}…
              </Link>
              .
            </p>
          )}
          {mine.length > 0 && !created && (
            <p>
              You own {mine.length} vault{mine.length === 1 ? "" : "s"} already, e.g.{" "}
              <Link className="link" to={`/scorecard/${mine[0]?.address}`}>
                {mine[0]?.address.slice(0, 10)}…
              </Link>
              .
            </p>
          )}
        </Step>

        <Step n={4} title="Fund it and post a quote">
          <p>
            Deposit WHYPE and PLUMBUSD into the vault and post a bid and ask, on the <Link className="link font-semibold" to="/maker">Maker</Link> page ("Inventory"
            and "Quote manually"). The ask side needs WHYPE, which is wrapped HYPE; the bid side needs PLUMBUSD from step 2. A quote goes stale after a few
            seconds, so a vault only counts while it is being refreshed.
          </p>
        </Step>

        <Step n={5} title="Bond into a campaign">
          {views === null ? (
            <p className="text-muted">Reading the chain for running campaigns…</p>
          ) : running.length === 0 ? (
            <p>
              <strong>No campaign is running right now</strong>, so there is nothing to bond into. A campaign is funded by a sponsor; you can{" "}
              <Link className="link font-semibold" to="/campaigns/new">open one yourself</Link> (the defaults cost 0.012 HYPE in rewards) or watch the{" "}
              <Link className="link" to="/campaigns">campaigns list</Link>.
            </p>
          ) : (
            <p>
              {running.length} campaign{running.length === 1 ? " is" : "s are"} running: {running.map((c) => campaignLabel(c.id)).join(", ")}. Bonding puts a small
              deposit behind your vault, slashed if probes catch it failing. Do it on the <Link className="link font-semibold" to="/maker">Maker</Link> page ("Bond into
              a campaign").
            </p>
          )}
        </Step>

        <Step n={6} title="Run a probe">
          <p>
            A probe checks every bonded vault in a campaign against its terms and pays the caller a small fee. It can only be sent when the probe gate is open:
            a random check on recent block hashes that a vault cannot predict, so quotes cannot be staged for it.
          </p>
          {running.length === 0 ? (
            <p className="rounded-[8px] border-2 border-ink bg-bg px-3 py-2 font-semibold">
              No campaign is running, so there is nothing to probe.
            </p>
          ) : (
            <>
              {running.length > 1 && (
                <label className="flex items-center gap-2">
                  <span className="text-muted">Campaign</span>
                  <select
                    className="rounded-[8px] border-2 border-ink bg-paper px-2 py-1 font-semibold"
                    value={target?.id ?? ""}
                    onChange={(e) => setCampaignId(Number(e.target.value))}
                  >
                    {running.map((c) => (
                      <option key={c.id} value={c.id}>
                        {campaignLabel(c.id)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  variant="primary"
                  disabled={!address || wrongNetwork || probeTx.busy || !gateKnown}
                  onClick={() => void runProbe()}
                >
                  {address ? "Run a probe" : "Connect a wallet"}
                </Button>
                <span className="num text-xs text-muted">
                  gate for {target ? campaignLabel(target.id) : ""}: {!gateKnown ? "reading…" : gate.data?.open ? "OPEN" : "closed"}
                  {gate.data ? ` · block ${gate.data.block.toString()}` : ""}
                </span>
              </div>
              {gateKnown && !gate.data?.open && (
                <p className="rounded-[8px] border-2 border-ink bg-highlight px-3 py-2">
                  <strong>The probe gate is closed right now.</strong> It opens when a recent block hash hits, at least {target ? duration(target.terms.minProbeInterval) : "a few seconds"} after the last
                  probe. Nothing is wrong: this page re-reads the gate every few seconds, and the button sends a probe only if the gate is open at that moment.
                  It opens at random, on average every few seconds to tens of seconds, and stays open for only about a second, so a probe has to be sent
                  right after it opens.
                </p>
              )}
              <p className="text-xs leading-5 text-muted">
                Being honest about this step: the gate stays open for about a second, and a browser wallet takes longer than that to confirm, so a probe sent by
                hand will usually revert with "gate closed" (and cost a little gas). The keeper bot sends probes automatically within that second.
              </p>
              {gate.isError && <p className="text-danger-text">Could not read the gate from any RPC node. Try again in a moment.</p>}
              {probeTx.state.status === "error" ? <p className="num text-xs text-danger-text">{friendly(probeTx.state.message)}</p> : <TxStatus state={probeTx.state} />}
            </>
          )}
        </Step>
      </ol>
      <Panel title="What this does and does not show" className="mt-8">
        <ul className="list-disc space-y-1.5 pl-5 text-sm leading-6">
          <li>Everything above runs on the Elysium testnet with testnet HYPE and the demo PLUMBUSD token. Nothing here has monetary value.</li>
          <li>No outside market maker has run on Plumbline yet. The vaults and campaigns you see besides yours were created by the project for the demo.</li>
          <li>
            The same steps work from the command line against the deployed contracts; the addresses are in the <a className="link" href={REPO_URL} target="_blank" rel="noreferrer">README</a>.
          </li>
        </ul>
      </Panel>
    </Page>
  );
}
