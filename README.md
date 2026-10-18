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
   (`{YEAR}FD.zip`) and diffs its document IDs against the database; then
   searches the Senate's eFD site for recent periodic transaction reports
   and does the same.
2. Fetches each new **Periodic Transaction Report** (PTR): a House PTR is a
   PDF, parsed by word coordinates; an electronic Senate PTR is an HTML page
   on eFD, parsed from its transactions table into the same vocabulary.
   Paper filings in either chamber are scans and are reported unreadable.
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
- `python -m whale classify-issuers [--budget-seconds 600]` — fetch EDGAR SIC
  codes for every traded ticker and Form 4 issuer and fold them into industry
  groups (the poll run does this on its own; see *Industry groups*)
- `python -m whale digest [--dry-run] [--days 7]` — the week in one Telegram
  message; `--dry-run` prints it and records nothing
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

**Watchlist** — members whose every trade is worth its own alert. Their filing
is split so each transaction arrives separately, rather than as one line inside
a per-filing digest that may have been truncated to fit:

```
🚨 WATCHLIST — Rep. Nancy Pelosi (D-CA11)
🟢 BUY  GOOGL  $250k–$500k
     Alphabet Inc. - Class A Common Stock · traded 12/30 (24d delay) · spouse

Filed 2026-01-23 · transaction 3 of 18
30d on GOOGL: 5 politicians · $132k net sell
```

```yaml
watchlist:
  - name: Nancy Pelosi
    bioguide_id: P000197     # authoritative; `name` is the fallback
    every_trade: true
```

**Weekly digest** — the week in one message, sent by the poll run on the first
run after Monday 07:00 UTC when `telegram.digest: true` in `config.yaml` (off
by default). Filings and trades by chamber, the tickers more than one member
touched with buyers and sellers apart, the largest equity trades as the
brackets they were filed in, who filed past the 45-day deadline, what was
sent, insider clusters and the largest insider buys (shares × reported
price), the scans by outcome, the pipeline's health in a line, and links to
the dashboard:

```
📬 Weekly digest · 2026-10-11 → 2026-10-18

Congress
House 11 filings · 112 trades (+1 queued) — Senate 0 filings · 0 trades
55 buys · 56 sells · volume $3.1M–$7.9M (est. mid $5.5M)
Most members: HD 2 (2 sell)
Largest equity trades, as filed:
🔴 SELL DVN $50k–$100k — Rep. Kevin Hern (R-OK1)
...
Filed past 45 days: none
Sent: 11 filing alerts · 4 congressional cluster · 3 insider cluster · 27 insider alerts

Insiders (Form 4) · values are shares × reported price
372 filings stored · 122 buys $366.3M · 1029 sells $1677.2M
Clusters (7d): 8 sold LQDA ($2.9M) · 7 sold FERG ($7.1M) · +8 more
Largest buys, one filing each:
🟢 SAFX $142.1M — EEME Energy SPV I, LLC
...

Scans 30 transcribed · 8 refused · 14 waiting · 7 Senate paper
Pipeline Senate ok · EDGAR ok · 14 queued
```

A congressional total is the sum of the disclosed brackets with its midpoint
labelled as the estimate it is, or `≥floor` when the open-ended top bracket is
in it; transcribed rows count as trades and never as money. The week sent is
recorded in `sync_state.digest_sent_week`, so a late Monday run catches up and
a second run does not repeat it. `python -m whale digest --dry-run` previews
the message at any time without recording anything.

Watched filings also ignore `ingest.max_filing_age_days` — that cutoff exists
to stop a first run replaying a year of everyone's history, and a member named
here is the case it is not protecting against. An unknown key or a malformed
`bioguide_id` is an error at startup, not an entry that silently watches
nobody. An empty (or absent) `watchlist` turns the feature off.

**Late filing** — a filing whose every trade was disclosed more than
`alerts.late_filing_days` (default 45, the STOCK Act's deadline; 0 = off) after
it was made leads its own message with how late it was. No extra message: the
filing is reported once, as itself.

```
⚠️ late by 66 days
🏛 New filing — Rep. Kevin Hern (R-OK1)
Filed 2026-06-20 · 2 transactions
🟢 BUY  TK0  $1,001–$15k
     traded 03/01 (111d delay)
```

The figure is the filing's: it was due 45 days after its earliest trade, and
that is how far past the due date it arrived. Each row still shows its own
delay. The filing is recorded once as a `late_filing` row in `alerts`, keyed on
the filing (document id and chamber), and the weekly audit lists the week's
filings with late trades. A filing with one timely trade among late ones gets
no prefix — the per-row delays say which were late. The delay is always trade
date → filing date, never the report's "Notification Date" column (see
[Coverage and its limits](#coverage-and-its-limits)). The dashboard ranks
members by late trades and worst delay at `/politicians?view=late`.

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

    - name: Large insider buy          # the people who set guidance
      direction: buy
      roles: [officer, director]
      min_value_usd: 1000000

    - name: Large 10% owner buy        # a fund building a position: a higher bar
      direction: buy
      roles: [ten_percent_owner]
      min_value_usd: 10000000

    - name: Unplanned executive sale
      direction: sell
      roles: [officer]
      min_value_usd: 5000000
      exclude_10b5_1: true             # a planned sale was scheduled months ago
```

A cluster and its members describe the same event, so the members are folded
into the cluster alert rather than sent alongside it, and a cluster speaks
again only once it is `insiders.cluster_refire_growth`× the size last reported
(default 1.5). Form 4 is due two business days after the trade, so a
coordinated purchase arrives as a burst and would otherwise re-alert on every
poll — one board's buying produced 25 messages for one decision before this.
The filing rules have the same memory: the same owner filing again in the same
issuer and direction within `insiders.filing_refire_days` (default 30) is
folded into history rather than re-alerted, until the run's cumulative value
reaches `cluster_refire_growth`× what was last reported — one message then
reads "3rd filing in 12 days · cumulative $22M". Nippon Life's 24 Corebridge
purchases in 33 days were 24 alerts before this.

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
| `SENATE_PROXY_URL` | no | fallback only: a sticky US proxy for Senate eFD, should it ever refuse the runner |
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

**Both chambers are covered; paper filings in either are not.**

The House Clerk publishes an unauthenticated bulk index and the filed PDFs, so
that half works from anywhere, including CI. The Senate publishes no bulk
file; its eFD search is the only route. `src/whale/senate.py` accepts eFD's
mandatory "prohibition agreement" once per session, searches for recent PTRs,
and fetches each electronic report page, which `src/whale/senate_ptr.py`
parses into the same transaction vocabulary as the House PDFs — so cluster
alerts, the statistics and the dashboard treat a senator's trade exactly like
a representative's.

eFD answers GitHub's US runners directly: the first run after the empty-proxy
fix (#16) recorded `ok: 100 filings seen` with no proxy. Its Akamai front
does refuse non-US addresses (a 403 on the agreement page itself), which is
where the earlier belief that it blocked datacenters came from. Should eFD
ever refuse the runner, `SENATE_PROXY_URL` is honoured as a fallback and must
be a *sticky* US proxy — the agreement is bound to the accepting IP, so a
rotating pool breaks the session even when individual requests get through.
A refusal or failure is recorded in `sync_state`, the run carries on with
House data, and the weekly audit warns.

Paper-filed Senate PTRs (`/search/view/paper/…`) are scanned page images.
They take the same path as a House paper filing: stored as unreadable with a
link, reported once, never transcribed.

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
  run records a gap and the poll runs that follow repair it from EDGAR's daily
  index, after reading the live feed and within
  `insiders.gap_repair_budget_seconds` per run — a gap that does not fit
  narrows to what is left and continues next run. Filings recovered this way
  pass through the same age gate as the feed, so a gap older than
  `max_filing_age_days` is history and never an alert. The same walk is
  available by hand as `python -m whale backfill-insiders --from … --to …`,
  which also loads history.
- **Late means past two business days**, federal holidays excluded, measured
  from the trade (or deemed execution) date to the filing date. The filer's own
  "late" box is kept separately, as filed.
- **Joint filings count once.** A founder and their holding company filing
  together are one decision; "distinct insiders" counts primary reporting
  owners only. Related parties filing *separately* still count twice.
- SEC asks for a contact e-mail in the User-Agent and refuses undeclared
  clients with an HTML page; `EDGAR_USER_AGENT` supplies it.

### Industry groups (SIC sectors)

The dashboard's sector views — a member's trades by sector, the sector
leaderboard on the tickers page, insider value bought and sold by sector —
come from EDGAR's Standard Industrial Classification code for each issuer.
Every ticker in the congressional tables is resolved to a CIK through EDGAR's
company list, every CIK (those plus every Form 4 issuer) has its submissions
record fetched, and the four-digit code is folded into one of twelve groups;
the table is the docstring of `src/whale/issuers.py`.

- **The fill runs inside the poll run**, after the insider sync, through the
  same throttled EDGAR client and under `issuers.budget_seconds`; a run that
  stops on the budget continues next time, and every classification is
  refreshed after `issuers.refresh_days`. `whale classify-issuers` is the
  manual form.
- **Unknown stays unknown.** ETF trusts and many funds carry no SIC at all;
  they, symbols EDGAR does not list, and issuers the fill has not reached yet
  are shown as *unclassified* and counted, never guessed at from a name. The
  weekly audit reports the share of equity rows that carry a group.
- A sector is a label on a row. It changes no total: the groups on a member's
  page add up to that member's trades, with the unclassified remainder as a
  row of its own.

### Other limits

- **Scanned paper filings.** About 11% of PTRs are filed on paper and arrive as
  image-only PDFs with no text layer. Without a Gemini key they are reported
  to Telegram with a link and contribute no transactions; `python -m whale
  status` counts them. Transcription (`vision.enabled` in `config.yaml`, on
  since 2026-10-17) is a hybrid: Gemini
  reads the written text, and `src/whale/paper_form.py` reads the ticked
  amount and type boxes off the printed grid, because the model misreads
  those on about a quarter of rows (issue #1). Transcribed rows are
  quarantined — labelled "transcribed from scan", counted as trades, and kept
  out of every volume total, cluster and floor — and a box the reader cannot
  call is stored as unknown rather than guessed. Paper forms carry no ticker,
  so they never feed a cluster alert either way. Measured accuracy and what
  turning it on does are in the `vision:` block of `config.yaml`. Every scan
  can be inspected regardless: `python -m whale capture-scans` stores each
  page as a small image with the grid reader's rows (resumable, no API key),
  and the dashboard's `/scans` page draws the reader's decisions over the
  page. The pipeline captures new scans as they arrive.
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

For Senate PTRs, where the risk is eFD changing its page template: whether
eFD answered at all (a refusal now warns, since the runner is normally
answered), and how many Senate filings parsed, were paper, or failed to
parse — the parser refuses to store an empty filing, so a template change
shows up as parse errors with the pages to open.

For SEC Form 4s, where the XML rarely fails to parse but *coverage* does: a
throttled or stalled EDGAR sync (which reports success while storing nothing),
a feed gap that needs a daily-index backfill, a stored filing with no rows or
no primary reporting owner, and values that no longer equal shares × the filed
price.

Needs `ANTHROPIC_API_KEY` as a repo secret for the analysis. Without it the
evidence is filed as a GitHub issue titled `Weekly review <date>` for a person
to read (appended as a comment while an earlier week's issue is still open);
only the analysis and PR step is skipped. The cron says Monday 07:00 UTC, but
GitHub delivers scheduled runs hours late, so treat that as the earliest.

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
