import { useQuery } from "@tanstack/react-query";
import { erc20Abi, formatEther, type Address } from "viem";
import { useAccount, useSwitchChain, useWatchAsset, useWriteContract } from "wagmi";
import { ELYSIUM_TESTNET, addressUrl, elysiumTestnet, faucetDeployment, plumbFaucetAbi } from "@plumbline/shared";
import { chainClient } from "../lib/chain";
import { useTxRunner } from "../lib/tx";
import { duration, fmtAmt, fmtDec } from "../lib/format";
import { useNow } from "../components/Snapshot";
import { TxStatus } from "../components/TxStatus";
import { WalletButton } from "../components/Layout";
import { AddrLink, Button, DemoTag, Page, PageHeader, Panel } from "../components/ui";

/** HYPE a claim needs for gas, with room to spare: far above what a claim costs. */
const MIN_GAS_WEI = 50_000_000_000_000n;
const TOKEN_DECIMALS = 6;
const TOKEN_SYMBOL = "PLUMBUSD";

interface FaucetState {
  pool: bigint;
  amount: bigint;
  cooldown: number;
  nextClaimAt: number;
  token: bigint;
  hype: bigint;
  block: bigint;
}

function useFaucet(account: Address | undefined) {
  const f = faucetDeployment;
  return useQuery({
    queryKey: ["faucet", f?.address, account ?? null],
    enabled: f !== null,
    refetchInterval: 12_000,
    retry: 1,
    queryFn: async (): Promise<FaucetState> => {
      if (!f) throw new Error("no faucet is deployed");
      const [pool, amount, cooldown, nextClaimAt, token, block, hype] = await Promise.all([
        chainClient.readContract({ address: f.address, abi: plumbFaucetAbi, functionName: "poolBalance" }),
        chainClient.readContract({ address: f.address, abi: plumbFaucetAbi, functionName: "amount" }),
        chainClient.readContract({ address: f.address, abi: plumbFaucetAbi, functionName: "cooldown" }),
        account ? chainClient.readContract({ address: f.address, abi: plumbFaucetAbi, functionName: "nextClaimAt", args: [account] }) : 0n,
        account ? chainClient.readContract({ address: f.token, abi: erc20Abi, functionName: "balanceOf", args: [account] }) : 0n,
        chainClient.getBlockNumber(),
        account ? chainClient.getBalance({ address: account }) : 0n,
      ]);
      return { pool, amount, cooldown: Number(cooldown), nextClaimAt: Number(nextClaimAt), token, hype, block };
    },
  });
}

const tok = (raw: bigint) => fmtAmt(raw, TOKEN_DECIMALS, 2);

/** What a failed claim means to a person, without the raw RPC text when we can tell. */
function friendly(message: string): string {
  if (/reject|denied|cancel/i.test(message)) return "You declined the request in your wallet, so nothing was sent.";
  if (/insufficient funds|exceeds the balance/i.test(message)) return "This wallet has no HYPE for gas.";
  return message;
}

export function FaucetPage() {
  const f = faucetDeployment;
  const { address, chainId, isConnected } = useAccount();
  const { switchChain, isPending: switching } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const { watchAsset } = useWatchAsset();
  const tx = useTxRunner();
  const now = useNow();
  const q = useFaucet(address);
  const s = q.data;

  const wrongNetwork = isConnected && chainId !== elysiumTestnet.id;
  const waitSec = s && s.nextClaimAt > now ? s.nextClaimAt - now : 0;
  const empty = s !== undefined && s.pool < s.amount;
  const noGas = s !== undefined && s.hype < MIN_GAS_WEI;
  const canClaim = Boolean(address) && !wrongNetwork && f !== null && waitSec === 0 && !empty && !noGas && !tx.busy;

  async function claim() {
    if (!f) return;
    const ok = await tx.run([
      { label: `claim ${TOKEN_SYMBOL}`, send: () => writeContractAsync({ address: f.address, abi: plumbFaucetAbi, functionName: "claim" }) },
    ]);
    if (ok) await q.refetch();
  }

  if (!f) {
    return (
      <Page density="expressive">
        <PageHeader kicker="Demo token" title="Faucet" sub="No faucet is deployed for this build, so there is nothing to claim here." />
      </Page>
    );
  }

  let action: { text: string; tone: "info" | "bad" } | null = null;
  if (!isConnected) action = null;
  else if (wrongNetwork) action = { text: `Your wallet is on another network. ${elysiumTestnet.name} is chain ${elysiumTestnet.id}.`, tone: "bad" };
  else if (s && empty) action = { text: "The faucet pool is empty. Nothing can be claimed until someone sends more PLUMBUSD to the faucet contract.", tone: "bad" };
  else if (s && waitSec > 0)
    action = { text: `This address already claimed. It can claim again in ${duration(waitSec)}, at ${new Date(s.nextClaimAt * 1000).toUTCString()}.`, tone: "info" };
  else if (s && noGas)
    action = { text: "This wallet has no HYPE for gas, and a claim is a transaction. Get testnet HYPE from the Elysium faucet first, then come back.", tone: "bad" };

  return (
    <Page density="expressive">
      <PageHeader
        kicker={
          <>
            Demo token <DemoTag />
          </>
        }
        title="Faucet"
        sub={
          <>
            Claim {s ? tok(s.amount) : fmtAmt(BigInt(f.amount), TOKEN_DECIMALS, 0)} {TOKEN_SYMBOL} for your address, once every{" "}
            {duration(f.cooldown)}. {TOKEN_SYMBOL} is the quote asset of the demo markets; it exists only on this testnet and is worth nothing.
          </>
        }
      />
      <div className="mt-8 grid gap-6 lg:grid-cols-[1.1fr_1fr]">
        <Panel title="Claim">
          {!isConnected ? (
            <div className="space-y-3 text-sm leading-6">
              <p>Connect a wallet to claim. Reading the pool needs no wallet.</p>
              <WalletButton />
            </div>
          ) : (
            <div className="space-y-3 text-sm leading-6">
              <p>
                Claiming to <AddrLink address={address ?? ""} n={6} />.
              </p>
              {wrongNetwork ? (
                <Button variant="primary" disabled={switching} onClick={() => switchChain({ chainId: elysiumTestnet.id })}>
                  Switch to {elysiumTestnet.name}
                </Button>
              ) : (
                <Button variant="primary" disabled={!canClaim} onClick={() => void claim()}>
                  {tx.busy ? "Claiming…" : `Claim ${s ? tok(s.amount) : "100"} ${TOKEN_SYMBOL}`}
                </Button>
              )}
              {action && (
                <p className={`rounded-[8px] border-2 border-ink px-3 py-2 font-semibold ${action.tone === "bad" ? "bg-danger-text text-paper" : "bg-highlight text-ink"}`}>
                  {action.text}
                </p>
              )}
              {noGas && !wrongNetwork && (
                <a className="link font-semibold" href={ELYSIUM_TESTNET.faucetUrl} target="_blank" rel="noreferrer">
                  Elysium testnet HYPE faucet (official)
                </a>
              )}
              {q.isError && (
                <p className="rounded-[8px] border-2 border-ink bg-bg px-3 py-2">
                  The chain could not be read just now, so the pool, your balance and your cooldown are unknown. You can still try to claim: the contract
                  decides, and a claim made too early or on an empty pool is refused.
                </p>
              )}
              {tx.state.status === "error" ? <p className="num text-xs text-danger-text">{friendly(tx.state.message)}</p> : <TxStatus state={tx.state} />}
              {tx.state.status === "done" && (
                <Button onClick={() => watchAsset({ type: "ERC20", options: { address: f.token, symbol: TOKEN_SYMBOL, decimals: TOKEN_DECIMALS } })}>
                  Show {TOKEN_SYMBOL} in my wallet
                </Button>
              )}
            </div>
          )}
        </Panel>
        <Panel title="Read from the chain" right={s ? <span className="num">block {s.block.toString()}</span> : undefined}>
          {q.isLoading ? (
            <p className="text-sm text-muted">Reading the faucet…</p>
          ) : q.isError ? (
            <p className="text-sm">Could not read the faucet from any RPC node. Try again in a moment.</p>
          ) : s ? (
            <dl className="space-y-2.5 text-sm">
              {[
                ["Pool left", `${tok(s.pool)} ${TOKEN_SYMBOL} (${(s.pool / s.amount).toString()} claims)`],
                ["Per claim", `${tok(s.amount)} ${TOKEN_SYMBOL}`],
                ["Cooldown", duration(s.cooldown)],
                ...(address
                  ? [
                      [`Your ${TOKEN_SYMBOL}`, tok(s.token)],
                      ["Your HYPE", fmtDec(Number(formatEther(s.hype)), 5)],
                      ["Your next claim", waitSec > 0 ? `in ${duration(waitSec)}` : "now"],
                    ]
                  : []),
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3">
                  <dt className="text-muted">{k}</dt>
                  <dd className="num text-right font-semibold text-ink">{v}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          <p className="mt-4 text-xs leading-5 text-muted">
            Faucet contract <AddrLink address={f.address} n={6} /> · token{" "}
            <a className="link" href={addressUrl(f.token)} target="_blank" rel="noreferrer">
              {TOKEN_SYMBOL}
            </a>
            . It has no owner and no admin functions; anyone can add to the pool by sending it {TOKEN_SYMBOL}.
          </p>
        </Panel>
      </div>
      <Panel title="Read this first" className="mt-6">
        <ul className="list-disc space-y-1.5 pl-5 text-sm leading-6">
          <li>
            <strong>{TOKEN_SYMBOL} is a demo asset.</strong> It has no value and is not a stablecoin; it is a mintable demo token.
          </li>
          <li>
            The cooldown is per address. Someone with many addresses can claim many times, so it limits casual repeat claims, not a determined drainer. If
            the pool runs dry, this page says so.
          </li>
          <li>
            A claim is a transaction and needs a little testnet HYPE for gas.{" "}
            <a className="link" href={ELYSIUM_TESTNET.faucetUrl} target="_blank" rel="noreferrer">
              The Elysium faucet
            </a>{" "}
            hands that out; this project does not.
          </li>
        </ul>
      </Panel>
    </Page>
  );
}
