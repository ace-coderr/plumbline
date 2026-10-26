# Plumbline runner (Cloudflare Workers)

Runs the keeper and the two maker bots on a schedule, on a free Cloudflare account, with nothing on your own
machine. It is built and tested, **not deployed, and switched off**: `bots.schedule.json` ships with
`"enabled": false`, and the Worker does nothing while that is so.

Why Cloudflare, with the measured numbers and the terms it was checked against: [`hosting-spike/README.md`](../../hosting-spike/README.md).

## How it works

* **`Supervisor`** (one Durable Object) wakes on a cron trigger every minute and keeps a 20-second alarm while a
  window is open. It reads the six wallets' HYPE balances in one call and applies [`core/budget.ts`](src/core/budget.ts):
  idle if the schedule is off, the kill switch is on, or it is outside a window; **stop at the daily cap; stop when any
  wallet is under its floor; stop if balances cannot be read for two minutes**. Otherwise it makes sure a campaign
  exists, then starts the three bots.
* **`Role`** (three Durable Objects: `keeper`, `makerA`, `makerB`) are alarm loops. A maker sends one `setQuote` about every
  second; the keeper polls the probe gate from both RPC nodes for ~3.5 s at a time and sends a probe the moment it opens.
  Each ends itself at its window's end, when the supervisor says stop, if the supervisor goes quiet for 2.5 minutes, or
  after ten failed sends in a row. **Nothing retries a failed send inside a tick.**
* **Campaign manager** ([`campaign.ts`](src/campaign.ts)): if there is no running v2 campaign on WHYPE/PLUMBUSD with at least
  20 minutes left, the **sponsor wallet** opens one with demo PLUMBUSD, enough epochs to outlast the window, and both
  runner vaults are bonded into it (the sponsor tops up a maker's PLUMBUSD for the bond if it is short). If the sponsor
  lacks PLUMBUSD or HYPE, or any step fails, the runner **halts and reports; it does not loop**.
* **The deployer key is never used.** It is not a secret the Worker can be given, and a key that derives to the deployer's
  address is refused. Each key is also checked against the address `bots.schedule.json` lists for that wallet, so a key pasted
  into the wrong secret stops the run instead of acting as the wrong wallet.
* **Logs** go through one redacting logger ([`core/log.ts`](src/core/log.ts)): every secret value, in every spelling, and
  anything shaped like a 32-byte hex value is removed from every line; fields named like secrets are dropped. Tests fail if a
  key can reach a log (`test/leak.test.ts`, with a random-key sweep and a source scan). Logs exist only in your Cloudflare account.
* `/status` on the site shows the schedule, the next window in UTC and Lagos time, and the last heartbeat read from the chain.

Public routes: `GET /health` (state, no secret in it, cached 15 s). Admin routes need `Authorization: Bearer <ADMIN_TOKEN>`:
`POST /kill`, `POST /resume`, `POST /tick`. Workflows or pull requests cannot trigger anything: there is no workflow.

## Secrets and funding (nothing is pasted into chat)

Secrets are Cloudflare Worker secrets. After the first deploy:
**Cloudflare dashboard → Workers & Pages → `plumbline-runner` → Settings → Variables and Secrets → Add → type "Secret"**,
or from this folder `npx wrangler secret put NAME` (it asks for the value with hidden input). Use your `.env` on your own machine as the source.

| secret | wallet | where the value comes from | address (in `bots.schedule.json`) | HYPE per day* | PLUMBUSD per day |
|---|---|---|---|---|---|
| `KEEPER_KEY` | keeper | `KEEPER_PRIVATE_KEY` in `.env` | `0xde85…E989` | ~0.01 | – |
| `QUOTER_A_KEY` | quoter A | `QUOTER_A_PRIVATE_KEY` | `0x415c…CaE5` | ~0.06 | – |
| `QUOTER_B_KEY` | quoter B | `QUOTER_B_PRIVATE_KEY` | `0xE83F…65d1` | ~0.06 | – |
| `MAKER_A_KEY` | maker A (owns vault A) | `MAKER_A_PRIVATE_KEY` | `0xE071…72eF` | ~0.0001 | 1 bond, from the sponsor |
| `MAKER_B_KEY` | maker B (owns vault B) | `MAKER_B_PRIVATE_KEY` | `0xA12c…32C3` | ~0.0001 | 1 bond, from the sponsor |
| `SPONSOR_KEY` | **new wallet** | make one (below) | set `wallets.sponsor` | ~0.001 | ~44 (42 pot + 2 bonds) |
| `ADMIN_TOKEN` | – | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` | – | – | – |

\* At the default schedule, one 4-hour window a day at one quote a second per maker (about 40,000 gas, 0.000004 HYPE, each).

Sponsor wallet, on your own machine:

1. Make a wallet (for example `cast wallet new`). Put its **address** (not the key) in `bots.schedule.json` under `wallets.sponsor`.
2. Add its key as the `SPONSOR_KEY` secret.
3. Send it HYPE for gas, and give it PLUMBUSD. PLUMBUSD can only be minted by the deployer, **once, by you, by hand**
   (this is not automation): `cast send 0x3A3a8e3D34BB815cc211976C17ccf3376C97d750 "mint(address,uint256)" <sponsor> 400000000 --rpc-url https://testnet-rpc.elysium.kinetiq.xyz --private-key <deployer key, typed in your terminal>`
   mints 400 PLUMBUSD (about nine days). The faucet gives only 100 per address per day.

Floors (`floorHype`) stop the run before a wallet is empty: 0.0003 HYPE for the keeper and quoters, 0.0004 for the sponsor.

## Deploy, turn on, turn off

```bash
cd packages/runner
npx wrangler login                # approve in the browser
npx wrangler deploy               # creates plumbline-runner on workers.dev; the schedule is still off
# add the secrets (above), put the sponsor address in bots.schedule.json, then:
#   set "enabled": true in bots.schedule.json, commit, and run  npx wrangler deploy  again
```

The first deploy needs a workers.dev subdomain on the account (Workers & Pages → Overview → Subdomain). The Worker uses no
domain, zone or route.

### Kill switch

1. **Instant:** `curl -X POST https://plumbline-runner.<your-subdomain>.workers.dev/kill -H "Authorization: Bearer <ADMIN_TOKEN>"`
   stops all three bots (each cancels its quote) and keeps them stopped, across windows and restarts, until
   `POST /resume`. `GET /health` shows `"killed": true`.
2. **At the source:** set `"enabled": false` in `bots.schedule.json`, commit, `npx wrangler deploy`.
3. **Remove the trigger:** dashboard → `plumbline-runner` → Settings → Triggers → delete the cron.
4. **Remove everything:** `npx wrangler delete`.
5. If a key may have leaked: move the wallet's funds out and stop using it; the runner holds nothing else worth taking.

## Limits worth knowing

* Workers Free allows 100,000 requests and 100,000 Durable Object rows written a day and 13,000 GB-s of duration; one
  4-hour window at the default cadence uses about a third of the request quota. A second window a day would be tight.
* Quotes go stale after 2 s on-chain; the makers refresh every 1 s. A host that stalls for a second or two lapses a quote.
* The public `/health` is cached, but the free request quota is shared with the bots: someone hammering the URL can still use up
  Worker requests (cron triggers would fail while the Durable Object alarms keep running).
* **Supervised test, 2026-10-26 (20-minute window): not clean.** The campaign opened (v2 #3, both vaults bonded), quotes and
  probes landed (7 of 8 probes), the kill switch worked (a wrong token gets 401; the right one stops all three bots and `/resume`
  restarts them), and the cap held (about 0.0016 HYPE spent). But **about half of the makers' `setQuote` sends failed with the
  RPC's "Rate Limit Exceeded"**, from both public nodes (the primary is also a Conduit endpoint). Cloudflare's shared outbound
  addresses get a small per-IP allowance, so the 3-poller keeper plus two makers is too much for them. Until the runner has an
  RPC with its own limit (a Conduit API node URL, from app.conduit.xyz/nodes, set as a secret) the schedule should stay off.
  The failures cost no gas, and the runner's responses held: makers back off 15 s after ten failures and end after six, the
  supervisor skips a campaign check that cannot read and halts after three in a row.
