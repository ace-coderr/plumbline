# Hosting spike: can a free host hold the bots' 2-second cadence?

Findings from 2026-10-26. Nothing here runs the bots, holds a key or sends a transaction.

## What has to run, and why

* **Maker bots (two):** a vault quote is stale after 2 seconds (`maxAge`), so each bot posts a new
  `setQuote` roughly every 0.5–1.5 s, plus a reference-price read about every 0.75 s. A gap longer than
  2 s is a failed probe for that maker.
* **Keeper:** the v2 probe gate is open for about 1.1 s. Landing a probe takes several gate pollers
  (about 8 reads a second) and a send within that second.
* So the host needs a process (or an alarm loop) that wakes every 1–2 s for hours, with outbound HTTPS
  to two RPC nodes and the price API, and holds a signing key.

## Measured with no key (from Lagos, `spike.mjs`-style run, 2026-10-26)

| | result |
|---|---|
| sign one EIP-1559 transaction (Node/V8) | median 1.4 ms, p95 2.1 ms |
| RPC `eth_blockNumber`, primary / Conduit | median 539 / 528 ms, p95 845 / 923 ms |
| RPC rate from one IP, 4 / 8 / 16 parallel | 7 / 15 / 30 calls per second, **no rate limiting** on either node |
| price feed (Hyperliquid testnet `allMids`) | median 587 ms, p95 1.4 s |

These are from one residential connection, not from a host's network. They show that signing is cheap
and the nodes accept the rate, not what latency a host would see.

## GitHub Actions: ruled out on the terms

Limits (GitHub docs, "Actions limits"): a GitHub-hosted job runs at most 6 hours, a workflow run at most
35 days. A loop inside a job could hold a 2-second cadence for up to 6 hours, relaunched by a schedule,
so the *limits* would not stop it.

The *terms* do. GitHub's additional-products terms list what Actions should not be used for: cryptomining,
activity that burdens GitHub's servers out of proportion to its benefit, and, on GitHub-hosted runners,
anything unrelated to producing, testing, deploying or publishing the software project in the repository.
They say misuse can mean terminated jobs, disabled repositories or account suspension. Running
market-maker bots that send transactions every second is operating a service, not building or testing the
repository. That is a real suspension risk for the account that also holds this repository, and there is
no honest way to read it as allowed. Not used.

## Cloudflare Workers Free + Durable Objects: possible on paper, unproven

From Cloudflare's docs (fetched 2026-10-26):

* Workers Free: 100,000 requests a day, 10 ms CPU per request, 50 subrequests per request.
* Durable Objects are available on Free (SQLite-backed only): 100,000 requests a day (alarm invocations
  count), 13,000 GB-s of duration a day, 100,000 rows written a day (each `setAlarm` is one row). An alarm
  handler may run up to 15 minutes of wall time with 30 seconds of CPU.
* Terms (Self-Serve Subscription Agreement and the developer-platform service terms): no clause against
  bots or trading; crypto-mining software is banned, services must be used as the developer documentation
  describes, and Cloudflare may end a Free service at its sole discretion.

Arithmetic for one 4-hour window with an alarm every 1.5 s: about 9,600 alarms per maker bot and a few
thousand for the keeper, about 3 subrequests each, so roughly 25,000 requests and 25,000 rows written a
day against 100,000 each, and about 5,400 GB-s against 13,000. Signing at 1.4 ms fits inside 10 ms.

What cannot be known without an account:

* how late alarms really fire (a 2-second quote tolerates about 0.5 s of lateness),
* latency from Cloudflare's edge to the two RPC nodes and the price API,
* whether the RPC nodes treat Cloudflare's shared outbound addresses differently,
* whether a 1.5-second repeating alarm is within what the developer documentation intends for alarms.

I cannot create an account or deploy for you, so these were not measured. `cloudflare/` is a keyless
probe that measures exactly these on your account in about ten minutes.

## Run the probe (no keys, no card)

1. Sign up at dash.cloudflare.com with email only (the Workers Free plan asks for no card).
2. In this folder: `cd hosting-spike/cloudflare`.
3. `npx wrangler login` (opens a browser to authorise), then `npx wrangler deploy`.
4. Open `https://plumbline-spike.<your-subdomain>.workers.dev/start`, wait 10 minutes (it stops itself
   after 400 ticks), then open `/report`.
5. Good enough for the bots: `alarmsLateOver500ms` near 0, `rpcPrimaryMs.p95` under about 400,
   `errors` empty. If alarms are often over 500 ms late, the quotes will lapse and this host is out.
6. Remove it afterwards: `npx wrangler delete`.

The probe is TypeScript, adds no dependency to the repository (it imports `viem` from the root
install) and is not part of `pnpm typecheck` or the build.
