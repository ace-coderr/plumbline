import { Link } from "react-router-dom";
import {
  DEPLOYED_SOURCE_TAG,
  REPO_URL,
  addressUrl,
  deployedSourceUrl,
  deployment,
  txUrl,
} from "@plumbline/shared";
import { N, Page, PageHeader } from "../components/ui";

const SLASH_TX = "0xc3d0bd9f3921ca7558416fd09cfcaff9566571024c8f3e0c01c5402e0f94233f";
const MAX_AGE = deployment.params.maxAge;
const WITHDRAW_DELAY = deployment.params.withdrawDelay;

function Ext({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="link">
      {children}
    </a>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-3 border-t-2 border-ink pt-5 sm:grid-cols-[56px_minmax(0,1fr)]">
      <div className="num text-3xl font-bold leading-none text-violet-text">{n}</div>
      <div className="min-w-0">
        <h2 className="font-display text-2xl font-extrabold tracking-display">{title}</h2>
        <div className="mt-2 max-w-3xl space-y-3 text-base leading-7">{children}</div>
      </div>
    </section>
  );
}

function Faq({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <div className="border-t-2 border-ink pt-4">
      <h3 className="font-display text-lg font-extrabold tracking-display">{q}</h3>
      <div className="mt-1.5 max-w-3xl space-y-2 text-base leading-7">{children}</div>
    </div>
  );
}

export function HowItWorksPage() {
  const campaigns = deployment.contracts.campaigns;
  return (
    <Page density="expressive">
      <PageHeader
        kicker="How it works"
        title={
          <>
            Market-making uptime,
            <br />
            <span className="marker">checked</span> by anyone.
          </>
        }
        sub="Token teams pay market makers to keep quotes on the book. Plumbline turns that promise into something a third party can check on-chain, at moments the maker cannot choose."
      />

      <section className="rounded-card border-2 border-ink bg-paper p-5 shadow-brut sm:p-7">
        <h2 className="font-display text-2xl font-extrabold tracking-display">What this demo is and isn't</h2>
        <ul className="mt-3 max-w-3xl list-disc space-y-2 pl-5 text-base leading-7">
          <li>
            It runs on <strong>Elysium testnet</strong>. No real money is involved anywhere on this site.
          </li>
          <li>
            <strong>There are no live funded campaigns right now.</strong> The site shows a finished demo.
          </li>
          <li>
            <strong>Every payout in this demo, rewards and probe fees, was in PLUMBUSD</strong>, a mintable demo token, not real
            money. Nobody was paid anything of value, and the project has no funding obligation to anyone.
          </li>
          <li>
            <strong>PLUMBUSD is a mintable demo token</strong> standing in for USDC, which is not faucet-available on Elysium
            testnet. Only the Plumbline deployer can mint it.
          </li>
          <li>
            <strong>Both market makers were run by the project author</strong>, from two wallets funded by the same deployer
            wallet, quoting with the bot in this repository. There are no independent participants yet.
          </li>
          <li>
            <strong>The slash was staged.</strong> A third vault was deliberately set up to advertise size it did not hold, and
            the author's own wallet traded against it to prove the mechanism. It was not an organic failure.
          </li>
          <li>
            <strong>What is real:</strong> the contracts, every probe, every settlement and the slash are transactions anyone
            can open on the explorer: the{" "}
            <Ext href={addressUrl(campaigns)}>campaigns contract</Ext>, the{" "}
            <Ext href={txUrl(SLASH_TX)}>slash</Ext>, and the verified source at tag{" "}
            <Ext href={deployedSourceUrl()}>
              <span className="num">{DEPLOYED_SOURCE_TAG}</span>
            </Ext>
            .
          </li>
        </ul>
      </section>

      <div className="space-y-8">
        <Step n={1} title="A quote vault, and a quote that expires">
          <p>
            A market maker deploys a <strong>vault</strong> for a pair (for example WHYPE/PLUMBUSD) and deposits tokens into it.
            The maker's bot posts a bid and an ask with a size on each side. The vault is the only place those tokens can be
            paid from.
          </p>
          <p>
            Every quote carries the time it was posted and <strong>expires after {MAX_AGE} seconds</strong>. After that nobody
            can fill it and a probe counts it as stale, so a maker that wants to stay on the book re-posts constantly. A quote
            that could sit for an hour says nothing about whether the maker is still there; one that must be re-stamped every{" "}
            {MAX_AGE} seconds is evidence of a maker that is present right now.
          </p>
        </Step>

        <Step n={2} title="A probe checks four things at one instant">
          <p>
            A <strong>probe</strong> is one transaction that checks every vault bonded into a campaign and records, on-chain,
            whether each one passed. A vault passes only if, at that block, its quote was:
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <strong>fresh</strong>: posted within the last {MAX_AGE} seconds;
            </li>
            <li>
              <strong>tight</strong>: spread no wider than the campaign's maximum;
            </li>
            <li>
              <strong>deep</strong>: ask size and bid value at or above the campaign's minimums;
            </li>
            <li>
              <strong>backed</strong>: the vault actually holds the tokens to pay both sides, read from its token balances at
              that moment, minus any withdrawal the maker has queued.
            </li>
          </ul>
          <p>
            Each pass is one point. A campaign exists only once a sponsor has funded its pool, and every payout comes from
            that pool: at the end of each epoch, that epoch's share is split between makers by points. The protocol has no
            treasury and never pays anyone itself. In this demo the author also acted as the sponsor, funding both pools with
            PLUMBUSD.
          </p>
        </Step>

        <Step n={3} title="Anyone can probe; the campaign's pool pays them">
          <p>
            <span className="num">probe()</span> has no access control. Whoever sends it earns the{" "}
            <strong>probe fee</strong>, paid from the campaign sponsor's pool: a share of the epoch's pot set in the campaign's
            terms (capped so fees can never take more than half of it). That fee is the reason a stranger bothers, and it
            exists only while a funded campaign is running.
          </p>
          <p>
            Probes cannot land at will. After a minimum interval, a probe is only accepted when a gate opens, decided by recent
            block hashes and a seed that changes with every probe: one block in 64 opens it, and an opening lasts 8 blocks.
            Nobody, the prober included, knows an opening is coming until the block that creates it.
          </p>
        </Step>

        <Step n={4} title="A quote that cannot be paid costs the maker">
          <p>
            Takers trade through the router. If a vault's quote looks fillable but the vault does not hold the tokens, the
            fill reverts; the router checks the shortfall on-chain and <strong>slashes 20% of the maker's bond</strong>. Half
            goes to the taker who found it, half into the epoch's pool for the honest makers. That payment comes only from the
            slashed maker's bond.
          </p>
          <p>
            Withdrawals are timelocked for {WITHDRAW_DELAY} seconds and stop counting as inventory the moment they are queued,
            so pulling tokens out right after a probe does not help.
          </p>
        </Step>

        <Step n={5} title="Why this only works on Elysium">
          <p>
            Checking constantly means two transactions per maker every second and a probe every few seconds. With{" "}
            <N>~140ms</N> blocks, a {MAX_AGE}-second quote has about 15 chances to be re-stamped before it expires; on a chain
            with one-second blocks it has 2, and one delayed transaction empties the book. The numbers, measured from this
            run's receipts, are on <Link to="/economics" className="link">Economics</Link>.
          </p>
        </Step>
      </div>

      <section className="space-y-4">
        <h2 className="display text-[32px] leading-[1] sm:text-[44px]">FAQ</h2>

        <Faq q='What exactly does "verified" mean here?'>
          <p>
            A figure is verified when it comes from a probe: a transaction in which the campaigns contract read the vault's
            quote and token balances itself and decided pass or fail. Each check is a <span className="num">ProbeResult</span>{" "}
            event on-chain. Nothing comes from the maker's own reporting or an off-chain feed.
          </p>
          <p>
            Uptime is the share of probes in which at least one maker passed. Spread and depth are medians over the quotes probes
            passed. Between probes nothing is verified; the claim is only as dense as the probes.
          </p>
        </Faq>

        <Faq q="Who can run a probe?">
          <p>
            Anyone with a little HYPE for gas: call <span className="num">probe(campaignId)</span> on the{" "}
            <Ext href={addressUrl(campaigns)}>campaigns contract</Ext> while its gate is open. The keeper in{" "}
            <Ext href={`${REPO_URL}/tree/main/packages/keeper`}>packages/keeper</Ext> does exactly that; it ran every probe in
            this demo, from the author's wallet. The probe fee comes out of the campaign sponsor's pool; with no funded
            campaign running, as now, there is nothing to probe and no fee to earn.
          </p>
        </Faq>

        <Faq q="What stops a maker from faking a quote?">
          <p>
            The probe does not trust the quote. It reads the vault's real token balances at that instant, net of queued
            withdrawals, and a quote advertising more than the vault holds fails. Separately, any taker can try to fill a quote
            at any time; if the vault cannot pay, the maker's bond is slashed and the taker receives half of the slashed
            amount.
          </p>
        </Faq>

        <Faq q="Can a maker predict when a probe is coming?">
          <p>
            No. The gate opens on a 1-in-64 chance per block, from block hashes nobody knows in advance, and the seed changes
            after every probe. A maker watching the chain learns of an opening at the same moment a keeper does, with about a
            second before it closes, so in practice its quote has to be fresh and its vault funded all the time.
          </p>
          <p>
            One caveat about this deployment: on Elysium the EVM's block number follows the parent chain, so the live contracts'
            gate opened every couple of minutes instead of every few seconds. Still unpredictable, just less frequent. The fix
            is in the repository and ships with the next deployment (see the README, "Found on Elysium").
          </p>
        </Faq>

        <Faq q="Is PLUMBUSD real money?">
          <p>
            No. It is an ERC-20 with 6 decimals that only the Plumbline deployer can mint, used because USDC cannot be obtained
            from a faucet on Elysium testnet. Testnet HYPE has no value either. Everything priced in PLUMBUSD on this site is
            labelled "demo asset".
          </p>
        </Faq>

        <Faq q="Who ran the market makers in this demo?">
          <p>
            The project author. Two vaults quoted WHYPE/PLUMBUSD at about 12 and 24 basis points with the bot in{" "}
            <Ext href={`${REPO_URL}/tree/main/packages/maker-bot`}>packages/maker-bot</Ext>, each from its own wallet, both
            wallets funded by the deployer. A third vault, also the author's, was set up to fail for the slashing
            demonstration. No outside maker has taken part yet.
          </p>
        </Faq>

        <Faq q="How do I check these numbers myself?">
          <ol className="list-decimal space-y-1 pl-5">
            <li>
              Open any probe from a <Link to="/report/WHYPE" className="link">report</Link> or campaign page on the explorer and
              read its <span className="num">ProbeResult</span> events.
            </li>
            <li>
              Compare the contract source verified on the explorer with tag{" "}
              <Ext href={deployedSourceUrl()}>
                <span className="num">{DEPLOYED_SOURCE_TAG}</span>
              </Ext>{" "}
              of the <Ext href={REPO_URL}>repository</Ext>.
            </li>
            <li>
              Rebuild every figure from chain events alone: the indexer in the repository reads only on-chain logs and receipts
              (<span className="num">pnpm export:static</span> reproduces this site's data). Each page shows the block the
              snapshot was taken at.
            </li>
          </ol>
        </Faq>
      </section>
    </Page>
  );
}
