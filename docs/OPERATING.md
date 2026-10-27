# Operating the Plumbline runner

This is the manual for the automated runner: the Cloudflare Worker that runs the keeper and the two market-maker bots, tops up
their wallets, and messages you on Telegram. It is written for one person running it on a free Cloudflare account. Everything
here is testnet (Elysium, chain 99801); no real money is involved.

**Rules that never change**

* Never paste a key, token or password into a chat, an issue, a commit or a screenshot. Every step below puts secrets where they
  belong without printing them.
* The deployer key (`DEPLOYER_PRIVATE_KEY`) stays on your own computer. It is never sent to Cloudflare, and the helper commands
  below refuse to send it.
* The treasury can only send HYPE to the wallets listed in `bots.schedule.json`. Nothing else can be paid by the runner.

**Where things happen.** Steps are written for three places, in this order:

* **Browser:** the Cloudflare dashboard (dash.cloudflare.com), Telegram, the explorer.
* **Terminal tab** in the Claude desktop app, or any terminal opened in the project folder. Commands start with `pnpm`.
* **A text editor** for `bots.schedule.json` and `.env` (any editor; the Claude app's file pane works).

**Before you start.** You need this project on your computer with `pnpm install` already run (see the README, "Running it"), and a
`.env` file in the project folder (copy `.env.example` and fill it in). `pnpm runner ...` and `pnpm check:all` read that `.env`, which must contain `RUNNER_URL` (your runner's address, see
[Find your runner's address](#find-your-runners-address)) and `ADMIN_TOKEN`.

---

## 1. Is everything healthy? (start here)

In a terminal tab, in the project folder:

```bash
pnpm check:all
```

It prints `PASS` or `FAIL` for each line: the three RPC nodes, the runner's last tick, the kill switch, any halt, the Telegram
secrets, a test message to your Telegram (add `--skip-telegram` to leave that out), every wallet against its floor, the treasury, the
PLUMBUSD balances, the heartbeat (`SKIP` if you have not set one up), and the last window's summary against the chain.

If it ends with `All checks passed.` you are done. If a line fails, find it below:

| FAIL line | What it means and what to do |
|---|---|
| `RPC ...` | A node did not answer. One failing public node is not urgent. If the private node fails, see [the private node](#the-private-node-failed). |
| `runner health` / last tick too old | The Worker is not waking up. In the browser: Cloudflare dashboard → Workers & Pages → `plumbline-runner` → Settings → Triggers: a cron `* * * * *` must be listed. If not, redeploy ([section 6](#6-redeploy-the-runner)). |
| `runner kill switch` is ON | Someone used the kill switch. Turn the bots back on with `pnpm runner resume` when you are ready. |
| `runner halt` | The runner stopped itself. The text says why; see the matching alert in [section 3](#3-the-telegram-alerts-and-what-to-do). |
| `runner schedule` | `enabled` is `false` in `bots.schedule.json`. Set it to `true` and redeploy to switch the schedule on. |
| `Telegram secrets` / `Telegram delivery` | Set them again: [section 7, Telegram](#telegram-bot-token-and-chat-id). |
| `wallet ...` under floor | Fund that wallet or let the treasury do it: [section 2](#2-fund-the-treasury). |
| `treasury` | Fund it: [section 2](#2-fund-the-treasury). |
| `sponsor PLUMBUSD` / `faucet pool PLUMBUSD` | Mint more PLUMBUSD: [section 3](#plumbusd-low). |
| `heartbeat` | The last ping to your monitoring service failed. | See [section 10](#10-the-heartbeat-optional). |
| `last window summary sent` | The runner has not posted the summary for the last finished window. Normal right after a fresh deploy until the next window has ended; otherwise look at the Worker logs ([section 3](#where-to-see-the-logs)). |

### Find your runner's address

Browser: Cloudflare dashboard → Workers & Pages → `plumbline-runner`. The address at the top looks like
`https://plumbline-runner.<your-subdomain>.workers.dev`. Add it to `.env` as `RUNNER_URL=...` (no trailing slash). Opening
`<that address>/health` in a browser tab shows the runner's state as plain data.

---

## 2. Fund the treasury

The treasury is a wallet that refills the bot wallets automatically (at the start of a window and every 30 minutes during it, when
a wallet holds less than 3 days of spend, it fills it to 10 days). You top the treasury up by hand now and then.

1. **Find its address.** Open `bots.schedule.json` and read `treasury.address`. (It is also shown on the site's Status page.)
2. **Get HYPE.** Testnet HYPE is free from the Elysium faucet: https://testnet.elysium.kinetiq.xyz/faucet/ . Or use your deployer
   wallet if it has spare. Keep some in the deployer for minting.
3. **Send it.** Browser: open your wallet (for example MetaMask), pick the Elysium testnet network (add it if it is missing: name
   "Elysium Testnet", chain id 99801, currency HYPE, RPC `https://testnet-rpc.elysium.kinetiq.xyz`), choose **Send**, paste the treasury address, enter an amount, confirm. A reasonable
   top-up is 1 HYPE; the bots together use roughly 0.13 HYPE a day, so 1 HYPE lasts over a week.
4. **Check.** Terminal: `pnpm check:all --skip-telegram` shows the treasury balance, or open the Status page. The Telegram "treasury low"
   alert fires under 0.5 HYPE.

The treasury will not send more than the daily limits in `bots.schedule.json` (`topUp.perWalletPerDayHype`, `topUp.totalPerDayHype`),
and it stops when it holds less than `treasury.minHype`.

To see what the next top-up would do without sending anything: `pnpm runner topup-plan`.
To prove the treasury works with one tiny real transfer (at most 0.001 HYPE): `pnpm runner topup-test makerA 0.0005`.

---

## 3. The Telegram alerts and what to do

Every message starts with "Plumbline runner:". Alerts go only to your chat. The same alert is never sent twice within an hour (`alerts.repeatMinutes`).

| The message starts with | Meaning | What to do |
|---|---|---|
| `the treasury holds X HYPE, under 0.5` | The treasury is getting low. | Fund it ([section 2](#2-fund-the-treasury)). Top-ups still work. |
| `the treasury is down to X HYPE, too low` | Below `treasury.minHype`: top-ups have stopped and wallets will run dry. | Fund it now. |
| `a top-up of <wallet> failed` | One transfer was refused or did not confirm. It is not retried until the next check, 30 minutes on. | Usually nothing. If it repeats, check the treasury balance and the Worker logs. |
| `the daily HYPE cap was reached` | The bots spent the day's allowance (`dailyHypeCap`) and stopped until the next UTC day. This is the safety working. | Nothing, unless you want a higher cap ([section 5](#5-change-the-schedule)). |
| `a wallet is under its floor` | A bot wallet is below its minimum, so the bots stopped. | The treasury normally fixes this at its next check and lifts this halt. If the treasury is empty, fund it first. A halt also ends by itself when the window ends; `pnpm runner resume` lifts it right away. |
| `halted (sponsor)` | The sponsor wallet has too little PLUMBUSD or HYPE to open a campaign. | Mint PLUMBUSD to it (below) or send it HYPE. |
| `halted (campaign)` | Opening or bonding a campaign failed. | Read the reason in the message and the Worker logs; fix; then `pnpm runner resume`. |
| `halted (config)` | A key is missing or belongs to the wrong wallet. | Re-set that secret from your `.env` ([section 7](#7-rotate-keys-and-secrets)). |
| `halted (rpc)` | Balances or the campaign could not be read for two minutes. | See [the private node](#the-private-node-failed). Then `pnpm runner resume`. |
| `<bot> ended early in the window` | A bot stopped on its own (an error, or ten failed sends in a row). | Check the Worker logs. `pnpm runner resume` clears halts; the bots restart at the next window. |
| `the private RPC node failed` | Reads or sends fell back to the public nodes, which limit how fast they answer. | See below. |
| `the kill switch was used` / `/resume was used` | Someone ran kill or resume. | If it was not you, rotate `ADMIN_TOKEN` ([section 7](#7-rotate-keys-and-secrets)). |
| `the faucet pool holds X PLUMBUSD` | The faucet is below 20,000. | Mint more (below). |
| `the sponsor wallet holds X PLUMBUSD` | The sponsor is below 2,000 and may not be able to open the next campaign. | Mint more (below). |
| `the <bot> bot restarted mid-window at HH:MM:SS UTC` | Cloudflare restarted that bot's Durable Object. Its counters were kept. | Nothing. The window summary lists restarts. |
| `window 13:00–17:00 UTC: N probes sent, ...` | The daily summary, built from the chain: probes sent, landed, reverted (with %), settles and the keeper's gas for the window. The last lines give HYPE spent over the **whole UTC day** and the least funding left. | Read it. If "least funding left" is a few days and the treasury is empty, fund the treasury. |
| `Health: all checks passed` / `Health: N failed` (the last lines of the daily summary) | The same checks as `pnpm check:all`, run a minute after each window: RPC nodes, the runner's own state, every wallet against its floor, the treasury, the sponsor and faucet PLUMBUSD, and the window figures against the chain. Passing groups show one `PASS` line; a failure shows its own `FAIL` line. | Act on each `FAIL` line using the table in [section 1](#1-is-everything-healthy-start-here). |
| `N health check(s) failed after the window` | A separate message, sent only when something in the Health block failed (once an hour at most), so it is not missed inside the daily summary. | Same as above. |
| `error in <bot> (<what>, <kind>): <short text>` | A failed send, call or uncaught exception, for example `keeper (probe send, Revert)`. One message per kind of error per hour; a later one says `(N similar error(s) since the last alert)`. At most 20 a hour; after that one notice says so and the rest are only logged. URLs, keys and tokens are removed. | One-off reverted probes are normal (the gate is only open about a second). Act if it repeats every hour: check the Worker logs, the node ([above](#the-private-node-failed)) and the balances. |
| `error in supervisor (heartbeat ping, ...)` | The runner could not reach your heartbeat monitor. It is not a problem with the bots; it only means the monitor may soon think the runner is down. | See [section 10](#10-the-heartbeat-optional). |
| `the window 13:00–17:00 UTC ended over 30 minutes ago and no summary was saved` | The daily summary did not happen. The message says if the kill switch is on or the runner is halted; otherwise the bots may not have run at all. | Run `pnpm check:all`, read the Worker logs, and fix what it shows. The next window runs as normal. |
| `(N earlier alert(s) could not be sent; the last at ...)` (added to a message) | Telegram was unreachable for some earlier alerts. They are counted, shown as `alertFailures` in the runner's `/health`, and reported here once a message gets through. | Usually nothing. If it keeps appearing, check the Telegram secrets ([section 7](#telegram-bot-token-and-chat-id)). |
| `test alert` | You (or `check:all`) asked for a test. | Nothing. |

### PLUMBUSD low

PLUMBUSD is a demo token that only the deployer can mint. In a terminal tab, in the project folder, with `DEPLOYER_PRIVATE_KEY` already
in your `.env` (the command reads it there and uses it only to sign on your computer; nothing is printed or sent anywhere else):

```bash
pnpm runner mint sponsor 500000
pnpm runner mint faucet 500000
```

The number is whole PLUMBUSD (1 to 1,000,000 per command). The command mints only to the sponsor (the `wallets.sponsor` address in
`bots.schedule.json`) or the faucet, never anywhere else, and prints the transaction and the new balance. The deployer needs a little
HYPE for gas.

### The private node failed

The private node is a free Conduit RPC URL kept as the secret `CONDUIT_RPC_URL`. If it fails the runner keeps working on the
public nodes, but they limit requests and bots may stall. Browser: log in to Conduit (app.conduit.xyz) → your Elysium testnet node and
check it is running and the key is active. If you made a new node or key, set the secret again ([section 7](#7-rotate-keys-and-secrets)).

### Where to see the logs

Browser: Cloudflare dashboard → Workers & Pages → `plumbline-runner` → **Logs** (turn on Workers Logs if asked). Terminal:
`cd packages/runner` then `npx wrangler tail` shows lines live. Logs have every secret removed.

---

## 4. Kill and resume the bots

The kill switch stops all three bots at once (each cancels its quote), stops top-ups too, and keeps everything off across windows and
restarts until you resume.

* **Terminal tab (fastest):** `pnpm runner kill` to stop, `pnpm runner resume` to start again. `pnpm check:all` shows
  `runner kill switch: ON/off`.
* **Browser only (if you have no terminal):** Cloudflare dashboard → Workers & Pages → `plumbline-runner` → Settings → scroll to the
  bottom → **Delete**. This stops everything at once, but it also deletes the Worker, its secrets and its saved state, so bringing it
  back means [section 8](#8-bring-the-whole-thing-up-on-a-new-cloudflare-account) again. Deleting only the cron trigger (Settings → Triggers) is gentler but
  only prevents *future* windows from starting: a window already running carries on until it ends.
* **At the source:** set `"enabled": false` in `bots.schedule.json`, commit, redeploy. This also works as a long-term pause.
* **Remove everything:** `cd packages/runner && npx wrangler delete`.

---

## 5. Change the schedule

Everything adjustable is in `bots.schedule.json` at the top of the project. Open it in an editor. The runner checks the file at
deploy time and refuses to start if it is malformed, so a typo fails loudly, not silently at window time.

| Setting | What it does |
|---|---|
| `enabled` | `true` runs the bots in their windows; `false` switches them off. |
| `windows` | A list of `{ "startUtc": "13:00", "minutes": 240 }`. Times are UTC every day (Lagos is UTC+1). |
| `dailyHypeCap` | Most HYPE all runner wallets may spend in a UTC day before the bots stop. |
| `floorHype` | Per wallet: the bots stop if it drops under this. |
| `topUp` | The treasury rule: `belowDays` and `toDays` (top up under 3 days to 10), `checkEveryMinutes`, `dailySpendHype` (the measured daily spend per wallet, used to count days), and the per-wallet and total daily limits. |
| `treasury` | `address`, `lowAlertHype` (alert level), `minHype` (stop level). |
| `alerts` | `repeatMinutes` (never repeat an alert inside this), `faucetLowPlumbusd`, `sponsorLowPlumbusd`. |
| `wallets` | The address of each runner wallet. The runner refuses a key that does not match. |
| `maker`, `campaign`, `vaults`, `referenceCoin` | How the bots quote and what campaign the sponsor opens. Change only if you know why. |

To apply a change:

1. Edit the file and save.
2. Terminal: `pnpm test` (it validates the schedule; all tests must pass).
3. Commit and push (`git add bots.schedule.json`, `git commit -m "..."`, `git push`).
4. Redeploy: [section 6](#6-redeploy-the-runner). The new schedule only takes effect after the deploy.

The Status page on the site reads the same file, so it updates when the site redeploys after the push.

---

## 6. Redeploy the runner

You redeploy after every change to the schedule or the runner code. The dashboard cannot do this; it needs a terminal.

1. Terminal tab, in the project folder: `git pull` (if you work from more than one machine), then `pnpm install`.
2. `pnpm test` — everything must pass.
3. `cd packages/runner`, then `npx wrangler login` the first time on this computer. A browser tab opens: approve it **immediately**;
   the login times out if you wait. If your Cloudflare login has more than one account, set `CLOUDFLARE_ACCOUNT_ID` in your terminal
   first (the account id is on the right of Workers & Pages → Overview).
4. `npx wrangler deploy`. It prints `Deployed plumbline-runner` and a version id. Your secrets and the bots' saved counters stay as
   they were.
5. Back in the project folder: `pnpm check:all --skip-telegram`.

Deploying during a window restarts the bots (their counters are kept) and sends a "restarted mid-window" alert.

---

## 7. Rotate keys and secrets

Rotating means making a new value, putting it in your `.env`, sending it to Cloudflare, and retiring the old one. The helper
commands do the middle steps without printing anything. After any rotation run `pnpm check:all --skip-telegram`.

General pattern for a wallet key:

1. `pnpm runner new-wallet <ENV_NAME>` (for example `KEEPER_PRIVATE_KEY`). It refuses if the name is already in `.env`: delete that
   one line in your editor first, but **copy the old key somewhere safe until its money has moved**. It prints only the new address.
2. Put the new address in `bots.schedule.json` (the `wallets` entry, or `treasury.address`).
3. Move the old wallet's HYPE (and PLUMBUSD for the sponsor) to the new address. Import the old key into your wallet app on your own
   computer (the app asks for it in its own import screen; never anywhere else), send, then remove it from the app.
4. `pnpm runner put-secrets <SECRET_NAME>` (the secret names are in the table below).
5. Commit the schedule change, redeploy ([section 6](#6-redeploy-the-runner)).

Per secret:

| Secret | Rotate by |
|---|---|
| `KEEPER_KEY` | The general pattern, with `KEEPER_PRIVATE_KEY`. |
| `QUOTER_A_KEY`, `QUOTER_B_KEY` | General pattern with `QUOTER_A_PRIVATE_KEY` / `QUOTER_B_PRIVATE_KEY`, plus one more step before the redeploy: the vault's owner (the maker wallet) must authorise the new quoter by calling `setQuoter(<new address>)` on that vault (wallets: `MAKER_A_PRIVATE_KEY` for vault A, `MAKER_B_PRIVATE_KEY` for vault B; the vault addresses are in `bots.schedule.json` under `vaults`). Until that call, the new quoter cannot quote. |
| `MAKER_A_KEY`, `MAKER_B_KEY` | These are vault owners. A vault's owner **cannot be changed**: rotating means creating a new vault and campaign bond, which is a project decision, not a routine step. If one may have leaked, move its funds out (it holds almost nothing) and plan the new vault. |
| `SPONSOR_KEY` | General pattern with `SPONSOR_PRIVATE_KEY`. Also move its PLUMBUSD to the new address, using the old sponsor key in a wallet app, or mint fresh PLUMBUSD to the new address. |
| `TREASURY_KEY` | General pattern with `TREASURY_PRIVATE_KEY`; move the treasury's HYPE across. |
| `ADMIN_TOKEN` | Edit `.env`: replace the value with a new random one (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` prints one; paste it into `.env` yourself). Then `pnpm runner put-secrets ADMIN_TOKEN`. |
| `CONDUIT_RPC_URL` | Browser: Conduit dashboard (app.conduit.xyz) → your Elysium testnet node → create or regenerate the key, copy the new URL straight into `.env`. Then `pnpm runner put-secrets CONDUIT_RPC_URL`. |
| `TELEGRAM_BOT_TOKEN` | Browser/Telegram: message @BotFather → `/revoke` (or `/token`) → choose your bot → copy the new token straight into `.env`. Then `pnpm runner put-secrets TELEGRAM_BOT_TOKEN`. |
| `TELEGRAM_CHAT_ID` | Only changes if you change the account that receives alerts. See below. |
| `HEALTHCHECK_URL` | In the monitoring service's dashboard make a new ping address (or regenerate the old one), then follow [section 10](#10-the-heartbeat-optional). |
| Deployer | Never on Cloudflare. If it leaks, make a new deployer wallet and redeploy contracts: a project decision. |

### Telegram bot token and chat id

1. **Make the bot (browser/phone).** In Telegram open **@BotFather**, send `/newbot`, give it a name and a username ending in `bot`.
   BotFather replies with a token. Copy it directly into `.env` as `TELEGRAM_BOT_TOKEN=...` (do not paste it anywhere else).
2. **Message the bot.** Open your new bot in Telegram and press **Start** (or send any message).
3. **Find your chat id (terminal tab).** `pnpm runner find-chat-id`. It reads the bot's pending messages, saves `TELEGRAM_CHAT_ID` to
   `.env`, and prints the chat id (that number is not a secret key, but keep it out of public places).
4. **Send both to Cloudflare.** `pnpm runner put-secrets TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID`.
5. **Test.** `pnpm runner alert-test`. The message should arrive in Telegram.

---

## 8. Bring the whole thing up on a new Cloudflare account

Time: about 30 minutes, mostly waiting for the browser approval and for transfers. You need: Node 20+, pnpm, this repository
installed (`pnpm install`), a `.env` with your local keys, and a little testnet HYPE in the deployer.

**A. The Cloudflare account (browser)**

1. Go to dash.cloudflare.com and create a free account. Verify the email.
2. Workers & Pages → Overview → set your **workers.dev subdomain** when asked (a free name of your choice). The runner uses no domain
   or zone of its own.

**B. Log in from the terminal**

3. Terminal tab, `cd packages/runner`, then `npx wrangler login`. Approve the browser tab immediately.
4. If you have several Cloudflare accounts, set `CLOUDFLARE_ACCOUNT_ID` first (the id is on the right of Workers & Pages → Overview).

**C. Wallets (terminal, project folder)**

5. Make any runner wallet that does not exist yet, one command each: `pnpm runner new-wallet SPONSOR_PRIVATE_KEY`,
   `pnpm runner new-wallet TREASURY_PRIVATE_KEY` (and the same for `KEEPER_PRIVATE_KEY`, `QUOTER_A_PRIVATE_KEY`, `QUOTER_B_PRIVATE_KEY` if you
   are starting with none). The maker (vault owner) wallets and the two vaults come from the project's seed step; see the README, "Running it".
6. Put each printed address in `bots.schedule.json`: `wallets.sponsor` and `treasury.address` (the others are already listed).
7. Send the new sponsor and treasury some HYPE from the deployer (wallet app, [section 2](#2-fund-the-treasury) step 3), and mint
   the sponsor PLUMBUSD ([section 3](#plumbusd-low)).

**D. Keys that are not wallets**

8. `ADMIN_TOKEN`: put a long random value in `.env` (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` prints one).
9. `CONDUIT_RPC_URL` (optional but recommended): create a free Elysium testnet node at app.conduit.xyz and put its URL in `.env`.
10. Telegram: follow [Telegram bot token and chat id](#telegram-bot-token-and-chat-id) up to step 3 (the Cloudflare step comes next).

**E. Deploy and send the secrets**

11. `cd packages/runner && npx wrangler deploy`. The first deploy creates `plumbline-runner`. The schedule is still whatever is in
    `bots.schedule.json`, so set `"enabled": false` first if you want to check everything before it runs.
12. Back in the project folder: `pnpm runner put-secrets` (sends every secret present in `.env`; the deployer key is not on the list).
    `pnpm runner secrets` lists the names that are now on the Worker.
13. Add `RUNNER_URL=https://plumbline-runner.<your-subdomain>.workers.dev` to `.env`.

**F. Check, then switch on**

14. `pnpm test`, then `pnpm check:all`. Fix anything that fails using [section 1](#1-is-everything-healthy-start-here). The last-window line fails
    until a window has run; that is expected on a new account.
15. Set `"enabled": true` in `bots.schedule.json`, commit, push, and redeploy ([section 6](#6-redeploy-the-runner)).
16. At the first window the supervisor opens a campaign, starts the bots, and sends the summary a minute after the window ends.
    To try it earlier, set a window a few minutes ahead, redeploy, and watch `pnpm check:all`.

The website is separate (it is hosted on Vercel and reads the chain from the browser). It does not need Cloudflare.

---

## 9. Every secret and setting the runner needs

Names only. **Cloudflare secret** = set on the Worker (dashboard → `plumbline-runner` → Settings → Variables and Secrets, or
`pnpm runner put-secrets NAME`). **`.env`** = your local file (never committed; the template is `.env.example`).

| Name | What it is | Where it lives | How to recreate it |
|---|---|---|---|
| `KEEPER_KEY` | Keeper wallet key | Cloudflare secret; local `.env` as `KEEPER_PRIVATE_KEY` | [section 7](#7-rotate-keys-and-secrets) |
| `QUOTER_A_KEY` | Quoter A key (posts quotes to vault A) | Cloudflare secret; `.env` as `QUOTER_A_PRIVATE_KEY` | Section 7 (needs `setQuoter` on the vault) |
| `QUOTER_B_KEY` | Quoter B key | Cloudflare secret; `.env` as `QUOTER_B_PRIVATE_KEY` | Section 7 |
| `MAKER_A_KEY` | Vault A owner key (bonds) | Cloudflare secret; `.env` as `MAKER_A_PRIVATE_KEY` | Cannot rotate; new vault needed |
| `MAKER_B_KEY` | Vault B owner key | Cloudflare secret; `.env` as `MAKER_B_PRIVATE_KEY` | Cannot rotate; new vault needed |
| `SPONSOR_KEY` | Sponsor wallet key (opens campaigns, pays the pot) | Cloudflare secret; `.env` as `SPONSOR_PRIVATE_KEY` | Section 7 |
| `TREASURY_KEY` | Treasury wallet key | Cloudflare secret; `.env` as `TREASURY_PRIVATE_KEY` | Section 7 |
| `ADMIN_TOKEN` | Password for kill, resume, tick, tests | Cloudflare secret; `.env` as `ADMIN_TOKEN` | Section 7 |
| `CONDUIT_RPC_URL` | Private RPC node URL (the key is in the URL) | Cloudflare secret; `.env` | Section 7, Conduit dashboard |
| `TELEGRAM_BOT_TOKEN` | Your alert bot | Cloudflare secret; `.env` | @BotFather, section 7 |
| `TELEGRAM_CHAT_ID` | Your Telegram chat | Cloudflare secret; `.env` | `pnpm runner find-chat-id` |
| `HEALTHCHECK_URL` | Optional. A heartbeat monitor's ping address ([section 10](#10-the-heartbeat-optional)) | Cloudflare secret; `.env` | Section 10 |
| `DEPLOYER_PRIVATE_KEY` | Deploys contracts, mints PLUMBUSD | **`.env` only. Never on Cloudflare.** | New wallet; project decision |
| `RUNNER_URL` | Your runner's address | `.env` only (used by `pnpm check:all` and `pnpm runner`) | [Find your runner's address](#find-your-runners-address) |
| `CLOUDFLARE_ACCOUNT_ID` | Which Cloudflare account to deploy to (only if you have several) | Your terminal or `.env`; not secret | Dashboard → Workers & Pages → Overview |

Settings that are not secret, all in the repository:

| Setting | File | Meaning |
|---|---|---|
| Schedule, caps, floors, wallet addresses, treasury, top-up rules, alert levels | `bots.schedule.json` | [Section 5](#5-change-the-schedule). Checked at deploy time. |
| Worker name, the every-minute cron, the two Durable Object classes | `packages/runner/wrangler.jsonc` | Change only to move to a different Worker name. |
| Contract addresses and the PLUMBUSD token | `packages/shared` (from the project's deployment record) | Change only after a new contract deployment. |
| Reference-price source for quotes | `bots.schedule.json` (`referenceCoin`) and the Hyperliquid public price API | Read-only public data, no key. |

**Where the runner keeps its own memory.** Cloudflare Durable Object storage inside your account: the kill switch, halts, the day's
starting balances, the top-up history and daily totals, alert timing, and the keeper's counters for the current window. Nothing is kept
on your computer.

---

## 10. The heartbeat (optional)

**What it is.** The runner can "check in" with a free monitoring service (for example healthchecks.io, Better Stack or Uptime Kuma). The
service gives you a private web address. Every 5 minutes, the runner opens that address once. If the runner stops checking in, the
service notices the silence and tells you (by email or its own Telegram link). It covers what the runner cannot report itself: the
whole Worker being stopped, deleted or broken.

**When it pings, and when it does not.** It pings every 5 minutes, whether or not a bot window is open, but **only while the runner is
healthy**: its last tick was recent, the kill switch is off, and no halt is in force. If any of those is wrong the ping is skipped on
purpose, so the monitor's silence is the alarm. With no address set it does nothing at all and sends no alert.

**What it never does.** The address is a secret: it is never written to a log, a Telegram message, the `/health` page or any file in
the project. If a ping fails (the service is down or slow), that is counted and reported like any other error, once an hour at most
(`error in supervisor (heartbeat ping, ...)`); it never stops the bots. One attempt, a 5-second limit, no retries.

**Set it up (browser, then terminal).**

1. Browser: sign up at a heartbeat monitoring service and create a check with a period of 5 minutes and a grace time of about 10
   minutes. Copy its ping address, but do not paste it into a chat.
2. Terminal tab, in the project folder: `pnpm runner set-env HEALTHCHECK_URL`. It asks for the address with hidden input (nothing shows
   as you paste) and saves it to `.env`.
3. `pnpm runner put-secrets HEALTHCHECK_URL` sends it to Cloudflare.
4. Wait about 5 minutes, then `pnpm check:all --skip-telegram`: the `heartbeat` line should say `PASS`. The monitoring service's
   dashboard should show the check as up.

**Rotate it.** In the service, create a new ping address (or regenerate the old one) and retire the old one. Delete the
`HEALTHCHECK_URL=` line in `.env`, then repeat steps 2 and 3. To switch the heartbeat off, delete the secret in the dashboard
(Workers & Pages, `plumbline-runner`, Settings, Variables and Secrets) and the line in `.env`.
