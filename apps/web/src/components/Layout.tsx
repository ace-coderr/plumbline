import { useEffect, useState } from "react";
import { Outlet, Link, useLocation } from "react-router-dom";
import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { REPO_URL, addressUrl, deployment, elysiumTestnet } from "@plumbline/shared";
import { STATIC, useCampaigns, useHealth, useKeeper, useMarkets } from "../lib/api";
import { SnapshotStamp, useNow } from "./Snapshot";
import { dateTime, fmtInt, short } from "../lib/format";
import { campaignSources, liveCounts } from "@plumbline/shared";
import { useLive } from "../lib/liveStore";
import { Wordmark } from "./Brand";
import { ThemeToggle } from "./ThemeToggle";
import { Button, Dot } from "./ui";
import { DesktopNav, MobileMenuButton, MobilePanel, SiteFooterLinks } from "./Nav";

/** Why connecting did not work, and what to do about it. */
function WalletHelp({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div className="absolute right-0 top-full z-30 mt-2 w-[min(20rem,calc(100vw-2rem))] rounded-[8px] border-2 border-ink bg-paper p-3 text-left text-xs leading-5 text-ink shadow-brut">
      <p className="font-semibold">{message}</p>
      <p className="mt-1.5">
        Reading this site needs no wallet. To send transactions, use a browser wallet extension (MetaMask, Rabby or similar)
        with Elysium testnet added: chain ID <span className="num">{elysiumTestnet.id}</span>, RPC{" "}
        <span className="num break-all">{elysiumTestnet.rpcUrls.default.http[0]}</span>, currency HYPE.
      </p>
      <button type="button" className="link mt-2" onClick={onClose}>
        Close
      </button>
    </div>
  );
}

export function WalletButton() {
  const { address, chainId, isConnected } = useAccount();
  const { connect, connectors, isPending, error, reset } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();
  const [help, setHelp] = useState(false);

  if (!isConnected) {
    const injected = connectors[0];
    const hasProvider = typeof window !== "undefined" && "ethereum" in window && Boolean((window as { ethereum?: unknown }).ethereum);
    const firstLine = error?.message.split(/\r?\n/)[0] ?? "";
    const problem = !hasProvider ? "No browser wallet found." : error ? `Could not connect: ${firstLine}` : null;
    return (
      <div className="relative">
        <Button
          className="h-9 px-3 text-xs"
          disabled={isPending}
          onClick={() => {
            if (!hasProvider || !injected) {
              setHelp(true);
              return;
            }
            reset();
            setHelp(true);
            connect({ connector: injected });
          }}
        >
          {isPending ? "Connecting" : "Connect"}
        </Button>
        {help && problem && (
          <WalletHelp
            message={problem}
            onClose={() => {
              setHelp(false);
              reset();
            }}
          />
        )}
      </div>
    );
  }
  if (chainId !== elysiumTestnet.id) {
    return (
      <Button variant="danger" className="h-9 px-3 text-xs" onClick={() => switchChain({ chainId: elysiumTestnet.id })}>
        <span className="sm:hidden">Switch</span>
        <span className="hidden sm:inline">Switch to Elysium</span>
      </Button>
    );
  }
  return (
    <Button className="h-9 max-w-[10rem] px-2.5 text-xs sm:px-3" onClick={() => disconnect()} title={`Disconnect ${address ?? ""}`}>
      <Dot tone="pass" />
      <span className="num truncate">{short(address, 3)}</span>
    </Button>
  );
}

function StatusBar() {
  const legacy = campaignSources.find((s) => s.version === "v1");
  const health = useHealth();
  const keeper = useKeeper();
  const markets = useMarkets();
  const campaigns = useCampaigns();
  const live = useLive();
  const now = useNow();
  const views = STATIC && live.status !== "error" ? live.data.views : null;
  const counts = views ? liveCounts(live.data, now) : null;
  // From the chain when it is being read, otherwise from the snapshot's own figures.
  const vaults = counts ? counts.vaults : (markets.data ?? []).reduce((a, m) => a + m.vaultCount, 0);
  const quoting = counts ? counts.quoting : (markets.data ?? []).reduce((a, m) => a + m.liveVaults, 0);
  const running = counts ? counts.running : (campaigns.data ?? []).filter((c) => now >= c.startTime && now < c.startTime + c.numEpochs * c.epochLength).length;
  const lastProbe = (campaigns.data ?? []).reduce((a, c) => Math.max(a, c.lastProbeAt ?? 0), 0);
  const h = health.data;
  const k = keeper.data;
  const indexerTone = health.isError ? "fail" : h && h.lagBlocks < 50 ? "pass" : "warn";
  const when = STATIC && !counts ? " at the snapshot" : " right now";
  return (
    <footer className="no-print fixed inset-x-0 bottom-0 z-20 flex h-7 items-center gap-4 overflow-hidden border-t-2 border-ink bg-paper px-4 text-2xs text-ink">
      <span className="num flex shrink-0 items-center gap-1.5">
        <Dot tone={STATIC ? (views ? "pass" : "none") : indexerTone} live={STATIC ? Boolean(views) : indexerTone === "pass"} />
        {STATIC
          ? views
            ? `chain #${fmtInt(views.head)}`
            : live.status === "error"
              ? "RPC unreachable"
              : `snapshot #${live.snapshot ? fmtInt(live.snapshot.block) : "…"}`
          : `indexer ${h ? `#${fmtInt(h.cursor)}` : health.isError ? "offline" : "…"}`}
      </span>
      {STATIC ? (
        <span className="num hidden shrink-0 md:inline">
          {lastProbe ? `last probe ${dateTime(lastProbe).replace("Z", " UTC")}` : "no probes yet"}
        </span>
      ) : (
        <span className="num flex shrink-0 items-center gap-1.5">
          <Dot tone={k ? "pass" : "none"} live={Boolean(k)} />
          keeper {k ? `${fmtInt(k.totals.probes)} probes` : "not running"}
        </span>
      )}
      <span className="num shrink-0">
        {quoting} of {vaults} vaults quoting{when}
        <span className="hidden sm:inline">
          {" "}
          · {running} campaign{running === 1 ? "" : "s"} running
        </span>
      </span>
      <span className="num hidden shrink-0 lg:inline">chain {deployment.chainId}</span>
      <span className="ml-auto flex shrink-0 gap-4">
        {(["factory", "router", "campaigns"] as const).map((c) => (
          <a
            key={c}
            href={addressUrl(deployment.contracts[c])}
            target="_blank"
            rel="noreferrer"
            className="num hidden hover:text-violet-text xl:inline"
            title={`${c} contract on the Elysium explorer`}
          >
            {c} {short(deployment.contracts[c], 4)}
          </a>
        ))}
        {legacy && (
          <a
            href={addressUrl(legacy.campaigns)}
            target="_blank"
            rel="noreferrer"
            className="num hidden hover:text-violet-text xl:inline"
            title="The first campaigns contract (v1, legacy) on the Elysium explorer"
          >
            v1 legacy {short(legacy.campaigns, 4)}
          </a>
        )}
        <a href={REPO_URL} target="_blank" rel="noreferrer" className="num font-semibold underline decoration-1 underline-offset-2 hover:text-violet-text">
          GitHub
        </a>
      </span>
    </footer>
  );
}

/**
 * On every page: what is real here and what is not. Testnet, a demo token with no value, no outside
 * market maker yet, and which figures are read from the chain and which are a labelled snapshot.
 */
export function TestnetNote({ className = "" }: { className?: string }) {
  return (
    <p className={`text-xs leading-5 text-muted ${className}`}>
      Elysium testnet demo; nothing here has monetary value. PLUMBUSD is a demo token. No outside market maker has run on Plumbline yet: the quotes and
      probes you see came from the project's own wallets and bots. Figures are read from the chain by your browser; the few that cannot be (gas, price,
      older fills) say "snapshot" and give its date.
    </p>
  );
}

/**
 * The site footer, in the same container as the page: the brand, a line about it and the demo note on the
 * left, the three link columns on the right. One column on a phone. The fixed status bar below it is a
 * separate element and the page's bottom padding keeps the two apart.
 */
export function SiteFooter() {
  return (
    <div className="no-print mt-10 grid gap-8 border-t-2 border-ink pt-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:gap-16">
      <div className="min-w-0 max-w-xl">
        <Link to="/" aria-label="Plumbline home" className="inline-block focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink">
          <Wordmark size={26} />
        </Link>
        <p className="mt-2 text-sm font-semibold text-ink">Probe-verified market-making uptime on Elysium.</p>
        <TestnetNote className="mt-3" />
      </div>
      <SiteFooterLinks />
    </div>
  );
}

export function Layout() {
  const { pathname } = useLocation();
  const [menu, setMenu] = useState(false);
  // The mobile panel closes on navigation.
  useEffect(() => setMenu(false), [pathname]);
  return (
    <div className="min-h-screen pb-14">
      <header className="no-print sticky top-0 z-20 border-b-2 border-ink bg-bg">
        <div className="mx-auto flex max-w-[1400px] items-center gap-x-3 px-4 py-2.5 lg:gap-x-6">
          <Link to="/" aria-label="Plumbline home" className="shrink-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink">
            <Wordmark size={22} compact />
          </Link>
          <DesktopNav />
          <div className="ml-auto flex min-w-0 items-center gap-1.5 sm:gap-2">
            <ThemeToggle />
            <WalletButton />
            <MobileMenuButton open={menu} onToggle={() => setMenu((m) => !m)} />
          </div>
        </div>
        {menu && <MobilePanel onClose={() => setMenu(false)} />}
      </header>
      <main className="mx-auto max-w-[1400px] px-4 py-6 sm:py-8">
        {STATIC && (
          <div className="no-print mb-6">
            <SnapshotStamp />
          </div>
        )}
        <Outlet />
        <SiteFooter />
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
