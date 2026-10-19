import { NavLink, Outlet, Link } from "react-router-dom";
import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { addressUrl, deployment, elysiumTestnet } from "@plumbline/shared";
import { useHealth, useKeeper } from "../lib/api";
import { fmtInt, short } from "../lib/format";
import { Wordmark } from "./Brand";
import { Button, Dot, cx } from "./ui";

const NAV = [
  { to: "/", label: "Markets", end: true },
  { to: "/campaigns", label: "Campaigns", end: false },
  { to: "/maker", label: "Maker", end: false },
  { to: "/economics", label: "Economics", end: false },
] as const;

export function WalletButton() {
  const { address, chainId, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();

  if (!isConnected) {
    const injected = connectors[0];
    return (
      <Button className="h-9 px-3 text-xs" onClick={() => injected && connect({ connector: injected })} disabled={!injected || isPending}>
        {isPending ? "Connecting" : "Connect"}
      </Button>
    );
  }
  if (chainId !== elysiumTestnet.id) {
    return (
      <Button variant="danger" className="h-9 px-3 text-xs" onClick={() => switchChain({ chainId: elysiumTestnet.id })}>
        Switch to Elysium
      </Button>
    );
  }
  return (
    <Button className="h-9 px-3 text-xs" onClick={() => disconnect()} title="Disconnect">
      <Dot tone="pass" />
      <span className="num">{short(address)}</span>
    </Button>
  );
}

function StatusBar() {
  const health = useHealth();
  const keeper = useKeeper();
  const h = health.data;
  const k = keeper.data;
  const indexerTone = health.isError ? "fail" : h && h.lagBlocks < 50 ? "pass" : "warn";
  return (
    <footer className="fixed inset-x-0 bottom-0 z-20 flex h-7 items-center gap-4 overflow-hidden border-t-2 border-ink bg-paper px-4 text-2xs text-ink">
      <span className="num flex shrink-0 items-center gap-1.5">
        <Dot tone={indexerTone} live={indexerTone === "pass"} />
        indexer {h ? `#${fmtInt(h.cursor)}` : health.isError ? "offline" : "…"}
      </span>
      <span className="num flex shrink-0 items-center gap-1.5">
        <Dot tone={k ? "pass" : "none"} live={Boolean(k)} />
        keeper {k ? `${fmtInt(k.totals.probes)} probes` : "unreachable"}
      </span>
      <span className="num hidden shrink-0 sm:inline">chain {deployment.chainId}</span>
      <span className="ml-auto hidden gap-4 md:flex">
        {(["factory", "router", "campaigns"] as const).map((c) => (
          <a key={c} href={addressUrl(deployment.contracts[c])} target="_blank" rel="noreferrer" className="num hover:text-violet">
            {c} {short(deployment.contracts[c], 4)}
          </a>
        ))}
      </span>
    </footer>
  );
}

export function Layout() {
  return (
    <div className="min-h-screen pb-14">
      <header className="sticky top-0 z-20 border-b-2 border-ink bg-bg">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2.5">
          <Link to="/" aria-label="Plumbline home">
            <Wordmark size={22} />
          </Link>
          <div className="ml-auto sm:order-last">
            <WalletButton />
          </div>
          <nav className="-mx-1 flex w-full gap-1 overflow-x-auto sm:mx-0 sm:w-auto">
            {NAV.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end}
                className={({ isActive }) =>
                  cx(
                    "shrink-0 rounded-[8px] border-2 px-3 py-1 text-sm font-semibold",
                    isActive ? "border-ink bg-violet text-paper" : "border-transparent text-ink hover:border-ink",
                  )
                }
              >
                {n.label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-[1400px] px-4 py-6 sm:py-8">
        <Outlet />
      </main>
      <StatusBar />
    </div>
  );
}

/** Minimal shell for the public report: no app chrome, just the certificate. */
export function BareLayout() {
  return (
    <div className="min-h-screen">
      <Outlet />
    </div>
  );
}
