# whale_tracker

Watches US congressional stock-trade disclosures and SEC Form 4 insider
filings, sends each new congressional filing to Telegram, alerts when several
members converge on the same ticker, and builds a queryable knowledge base of
**who traded what, how much, and how many of them**.

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
6. Pulls new **SEC Form 4** filings — corporate officers, directors and 10%
   owners — from EDGAR's live feed, keeps the ones with meaningful open-market
   trades, and stores them in their own tables (see *Corporate insiders*).

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
- `python -m whale insiders [--since 30d] [--by value|insiders] [--direction buy|sell]` —
  issuers ranked by insider buying and selling
- `python -m whale insiders --clusters` — issuers where several insiders traded the same way
- `python -m whale insider AAPL` — every stored insider trade in one issuer
- `python -m whale insider-alerts [--show-message]` — which stored filings the
  configured alert rules match, without sending anything
- `python -m whale status` — ingestion and coverage
- `python -m whale audit` — data-integrity and pipeline-health report

### Amounts are ranges, not figures

This is the most important thing to understand about the data. The STOCK Act
requires members to disclose only a **bracket** — "$1,001 – $15,000" — never an
exact amount. So:

- every stored transaction keeps `min` and `max`;
- a "volume" figure is a sum of bracket midpoints and is always labelled an
  estimate;
- the open-ended top bracket ("Over $50,000,000") has no maximum, so any total
  containing one is reported as `≥` rather than given a fabricated upper bound.

Insider trades are the one exception: Form 4 states share counts and a price
per share, so their value is `shares × price` — exact, but labelled as computed,
because a filer may report a weighted-average price whose real range sits in a
footnote. A row with no price has an unknown value, never a zero.

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

**Insider alerts** — Form 4 filings are far too numerous to announce wholesale,
so they alert only against rules you write. Each new filing is tested in order
and the **first match names the alert**:

```
🟢 CEO or CFO buying — PVH
Larsson Stefan (Chief Executive Officer, Director) bought $1M of PVH CORP. /DE/
Filed 2026-09-11 · traded 2026-09-11

🟢 14,179.10 sh @ $70.53 = $1M

https://www.sec.gov/Archives/edgar/data/1558755/.../0001123292-26-001286-index.htm
```

The line shows the arithmetic on purpose: a Form 4 value is shares × the price
as filed, and printing the inputs means nobody has to wonder whether the figure
was disclosed or derived.

```yaml
insiders:
  alerts:
    - name: Insider cluster buying     # several insiders at once
      kind: cluster
      direction: buy
      min_insiders: 3
      window_days: 30

    - name: CEO or CFO buying          # specific rules go first
      direction: buy
      titles: ["chief executive", "ceo", "chief financial", "cfo"]
      min_value_usd: 100000

    - name: Unplanned executive sale
      direction: sell
      roles: [officer]
      min_value_usd: 2000000
      exclude_10b5_1: true             # a planned sale was scheduled months ago
```

A rule may set `direction` (buy/sell/any), `min_value_usd` (summed per
direction within one filing), `roles` (director / officer / ten_percent_owner /
other), `titles` (case-insensitive substrings of the officer title as filed),
`exclude_10b5_1` or `require_10b5_1`, and for `kind: cluster`, `min_insiders`
and `window_days`. An unknown key or value is an error at startup, not a rule
that silently never matches. An empty `alerts` list means no insider alerts.

Preview rules against filings already stored before trusting them — nothing is
sent:

```sh
python -m whale insider-alerts --since 30d          # what the rules would catch
python -m whale insider-alerts --show-message       # the exact Telegram output
```

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
| `EDGAR_USER_AGENT` | no | SEC Form 4 ingestion; SEC requires `whale-tracker you@example.com` — without it the insider step skips |

### 3. First run

```sh
pip install -e ".[dev]"
python -m whale init-db
python -m whale sync                      # index filings; only recent ones queue for Telegram
python -m whale backfill --year 2026      # parse the year's history into the DB, silently
python -m whale run --dry-run             # preview the messages without sending
python -m whale run
EDGAR_USER_AGENT="whale-tracker you@example.com" python -m whale sync-insiders   # SEC Form 4
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

### Corporate insiders (SEC Form 4)

Officers, directors and 10% owners must report their trades on **Form 4**
within two business days. The pipeline reads EDGAR's live feed
(`browse-edgar?action=getcurrent&type=4`) every run and stores filings in
separate `insider_*` tables — never mixed into the congressional data.

- **Only open-market trades above a floor are kept.** Roughly 420 Form 4s are
  filed every business day and most are compensation plumbing: option
  exercises, tax withholding, grants, gifts. A filing is stored only if its
  open-market (or private) purchases or sales — codes `P`/`S` — sum to at least
  `insiders.min_trade_usd` ($50,000 by default) in one direction, and only
  those rows are stored. Rejected filings are not recorded; the run counts them
  and the Pipeline view shows the tally.
- **Skipped for now:** amendments (`4/A`), Forms 3 and 5, and the derivative
  table (options, warrants).
- **The feed remembers ~2000 entries, about two business days.** A cursor
  marks how far each run got; if the pipeline is down longer than that, the
  run records a gap and `python -m whale backfill-insiders --from … --to …`
  repairs it from EDGAR's daily index. The same command loads history.
- **Late means past two business days**, federal holidays excluded, measured
  from the trade (or deemed execution) date to the filing date. The filer's own
  "late" box is kept separately, as filed.
- **Joint filings count once.** A founder and their holding company filing
  together are one decision; "distinct insiders" counts primary reporting
  owners only. Related parties filing *separately* still count twice.
- SEC asks for a contact e-mail in the User-Agent and refuses undeclared
  clients with an HTML page; `EDGAR_USER_AGENT` supplies it.

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
  else. The delay is measured from the trade to the date the report reached the
  Clerk. The report's separate "Notification Date" — when the member learned of
  the trade — is tracked as `LAG`: a nonzero lag means someone else placed the
  trade (a spouse, trust or managed account) and carries no compliance meaning.

## Dashboard

A Next.js app in `web/`, hosted on Vercel, reading the committed database.

- **Feed** — every disclosed trade, filterable by member and direction
- **Tickers** — volume and participation leaderboards, plus per-ticker detail
- **Politicians** — per-member volume, breadth, and disclosure delay
- **Insiders** — SEC Form 4 open-market trades: issuers where insiders converge,
  most bought / most sold, every stored trade with role, 10b5-1 flag and lateness
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
| `TRADES_DB_TOKEN` | a fine-grained PAT with **Contents: read** on this repo only |

Set both for **Production** (and Preview, if you want PR previews to load
data), then **redeploy** — Vercel only picks up environment changes on a new
deployment, so an existing one keeps failing until you trigger one.

(For a public repo, set `TRADES_DB_URL` to the raw URL instead and skip the
token.) Either way the app fetches with a 2-minute cache, so it tracks the
bot's commits without redeploying.

Locally, no configuration is needed — it reads `../data/trades.sqlite3`
directly.

## Weekly self-review

A second workflow (`.github/workflows/weekly-review.yml`) runs Mondays. It
gathers evidence deterministically — `whale audit` over the database, plus a
digest of the `poll` workflow's runs and failure logs — then has Claude decide
whether anything is genuinely wrong and, if so, open a **draft** PR fixing the
single most valuable thing.

The audit is the substance and is useful on its own:

```sh
python -m whale audit                 # markdown report
python -m whale audit --fail-on error # exit 1 on an error-severity finding
```

It looks for the failure mode this project actually has — plausible-looking
wrong numbers rather than crashes — and covers both sources, which fail
differently.

For House PTRs, where the risk is a mis-split PDF column: filings that parsed
to zero transactions, amounts off the statutory bracket ladder, tickers that
are really CUSIPs, filings stuck in the queue, unmatched filers, and a drop in
rows-per-filing that would signal the Clerk changing the PDF template.

For SEC Form 4s, where the XML rarely fails to parse but *coverage* does: a
throttled or stalled EDGAR sync (which reports success while storing nothing),
a feed gap that needs a daily-index backfill, a stored filing with no rows or
no primary reporting owner, and values that no longer equal shares × the filed
price.

Needs `ANTHROPIC_API_KEY` as a repo secret. Without it the audit still runs and
is uploaded as a build artifact; only the analysis and PR step is skipped.

## Development

```sh
.venv/bin/python -m pytest -q
```

Tests cover the amount bracket ladder, the PDF parser against committed real
filings (including a multi-page one and a scan), roster matching on awkward
congressional names, cluster thresholds and dedupe, Telegram formatting at the
4096-character limit, and — for insiders — EDGAR feed and index parsing, Form 4
XML against two real filings, the sync cursor's failure modes over a mock
transport, the two-business-day clock, and the schema migration.
