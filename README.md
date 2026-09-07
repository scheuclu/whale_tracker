# whale_tracker

Watches US congressional stock-trade disclosures, sends each new filing to
Telegram, alerts when several members converge on the same ticker, and builds a
queryable knowledge base of **who traded what, how much, and how many of them**.

Sibling project to `youtube_finance_bro`, same shape: a Python pipeline on
GitHub Actions, a SQLite database committed back to the repo, and a Next.js
dashboard on Vercel that reads it.

## How it works

A GitHub Actions workflow runs every 3 hours:

1. Downloads the House Clerk's bulk disclosure index for the year
   (`{YEAR}FD.zip`) and diffs its document IDs against the database.
2. Fetches each new **Periodic Transaction Report** (PTR) PDF and parses the
   transaction table by word coordinates.
3. Resolves the filer to a member — party, state, district — via
   `unitedstates/congress-legislators`.
4. Stores everything in `data/trades.sqlite3` (committed back; it is both the
   pipeline state and the knowledge base).
5. Sends the filing to Telegram, then checks whether any ticker has crossed a
   **cluster** threshold and alerts separately if so.

Failures resume on the next run via a per-filing status state machine — nothing
is parsed or announced twice.

## What it tracks

```sh
python -m whale tickers --by politicians --since 90d
```

```
TICKER   PEOPLE  TRADES   BUY/SELL   VOLUME (mid)   RANGE
──────────────────────────────────────────────────────────────
MSFT         16      50      29/21          $3.7M   $2.3M–$5.2M
AAPL         15      39      23/16         $30.9M   $10.4M–$51.4M
NVDA         12      30      12/18          $3.5M   $1.2M–$5.8M
```

- `python -m whale tickers [--by volume|politicians] [--since 90d]` — leaderboard
- `python -m whale ticker NVDA` — who traded it, when, for how much
- `python -m whale politicians` — per-member volume, breadth, disclosure delay
- `python -m whale status` — ingestion and coverage

### Amounts are ranges, not figures

This is the most important thing to understand about the data. The STOCK Act
requires members to disclose only a **bracket** — "$1,001 – $15,000" — never an
exact amount. So:

- every stored transaction keeps `min` and `max`;
- a "volume" figure is a sum of bracket midpoints and is always labelled an
  estimate;
- the open-ended top bracket ("Over $50,000,000") has no maximum, so any total
  containing one is reported as `≥` rather than given a fabricated upper bound.

## Telegram

**Per filing** — one message when a new disclosure is parsed, with the rolling
aggregate for each ticker in it:

```
🏛 New filing — Rep. Kevin Hern (R-OK1)
Filed 2026-09-01 · 29 transactions

🟠 SELL (partial)  ADBE  $15k–$50k
     Adobe Inc. - Common Stock · traded 08/14 (13d delay) · joint
🔴 SELL  BA  $1,001–$15k
     Boeing Company · traded 08/13 (14d delay) · joint
...
90d on ADBE: 3 politicians · $61k net sell
```

**Cluster** — when members converge on one ticker in the same direction:

```
🔥 CLUSTER ALERT — SPCX
4 politicians bought in the last 90 days
Volume $18k–$95k (mid $57k) · 4 buys
Daniel Meuser, Gilbert Ray Cisneros, Jr., Jared Moskowitz, John J. McGuire III
```

Thresholds live in `config.yaml`: 3+ distinct members in the same direction, or
$500k+ estimated volume, inside a rolling window. A `(ticker, direction)` only
re-alerts once more members join it.

## Setup

### 1. Telegram bot

- Message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the **bot token**.
- Send any message to your new bot, then open
  `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy the **chat id**.

### 2. GitHub repo secrets

Settings → Secrets and variables → Actions:

| Secret | Required | Purpose |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | notifications |
| `TELEGRAM_CHAT_ID` | yes | notifications |
| `GEMINI_API_KEY` | no | reads scanned paper filings (~11% of PTRs) |
| `SENATE_PROXY_URL` | no | sticky residential proxy for Senate eFD |

### 3. First run

```sh
pip install -e ".[dev]"
python -m whale init-db
python -m whale sync                      # index filings; only recent ones queue for Telegram
python -m whale backfill --year 2026      # parse the year's history into the DB, silently
python -m whale run --dry-run             # preview the messages without sending
python -m whale run
```

`backfill` deliberately does **not** notify. Cluster alerts are meaningless
against an empty database — "3 politicians bought NVDA" needs history to be
true — so the history is loaded quietly before live alerting starts.

## Coverage and its limits

**The House is fully covered. The Senate is not.**

The House Clerk publishes an unauthenticated bulk index and the filed PDFs, so
that half works reliably from anywhere, including CI. The Senate publishes no
bulk file; its eFD search is the only route and sits behind Akamai bot
protection that returns 403 to datacenter addresses regardless of headers. It
also binds its mandatory "prohibition agreement" to the requesting IP, so a
rotating proxy pool breaks the session even when individual requests get
through.

`src/whale/senate.py` implements the scraper and honours `SENATE_PROXY_URL`,
but a block is treated as expected: the run logs it, records it in
`sync_state`, continues with House data, and the dashboard states plainly that
the figures are House-only.

Third-party aggregators were evaluated as an alternative and rejected: the
house/senate-stock-watcher S3 datasets return `AccessDenied`, the Capitol Trades
backend 503s, and Quiver Quantitative is paywalled. Depending on any of them
would trade a verifiable primary source for an unreliable secondary one.

### Other limits

- **Scanned paper filings.** About 11% of PTRs are filed on paper and arrive as
  image-only PDFs with no text layer. They are reported to Telegram with a link
  and contribute no transactions; `python -m whale status` counts them.
  Gemini transcription exists (`vision.enabled` in `config.yaml`) but is **off
  by default**: the paper form records amounts as a checkbox grid with rotated
  headers that every model tested misreads, at roughly a 25% row error rate.
  Measurement and proposed fix: https://github.com/scheuclu/whale_tracker/issues/1
- **Assets without tickers.** Treasury bills, municipal bonds, structured notes
  and private funds are stored but carry no symbol, so they appear in a member's
  totals and not in ticker rollups. Some members trade almost nothing else.
- **Filing typos are reproduced, not corrected.** A few filings carry a mistyped
  year (one 2026 filing reports a trade date *after* its own disclosure date).
  The parse stays faithful to the PDF; the UI marks the row and reports no
  delay rather than inventing one.
- **A late disclosure is a reporting fact.** Missing the 45-day deadline is
  surfaced because it is what the filings prove. It is not evidence of anything
  else.

## Dashboard

A Next.js app in `web/`, hosted on Vercel, reading the committed database.

- **Feed** — every disclosed trade, filterable by member and direction
- **Tickers** — volume and participation leaderboards, plus per-ticker detail
- **Politicians** — per-member volume, breadth, and disclosure delay
- **Pipeline** — ingestion status, unreadable filings, and coverage

```sh
cd web && npm install && npm run dev      # reads ../data/trades.sqlite3 directly
```

For Vercel: set **Root Directory** to `web/`, then point the app at the
committed database. The repo is private, so `raw.githubusercontent.com` will
404 — use the authenticated contents API instead:

| Env var | Value |
|---|---|
| `TRADES_DB_REPO` | `scheuclu/whale_tracker` |
| `GITHUB_TOKEN` | a fine-grained PAT with **Contents: read** on this repo only |

(For a public repo, set `TRADES_DB_URL` to the raw URL instead and skip the
token.) Either way the app fetches with a 2-minute cache, so it tracks the
bot's commits without redeploying.

Locally, no configuration is needed — it reads `../data/trades.sqlite3`
directly.

## Development

```sh
.venv/bin/python -m pytest -q
```

Tests cover the amount bracket ladder, the PDF parser against committed real
filings (including a multi-page one and a scan), roster matching on awkward
congressional names, cluster thresholds and dedupe, and Telegram formatting at
the 4096-character limit.
