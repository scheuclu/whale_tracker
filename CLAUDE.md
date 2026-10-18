# Project instructions

## Workflow: all changes via PR

Never commit or push directly to `main`. For every change: create a feature
branch, commit there, push, and open a PR for review.

**Exception:** the scheduled GitHub Actions workflow commits
`data/trades.sqlite3` (pipeline state) directly to `main` — that is by design
and must stay.

## Non-negotiable: amounts are ranges

The STOCK Act requires only a bracket ("$1,001 - $15,000"). Any code path that
collapses a bracket to a single number without labelling it an estimate is a
bug, not a simplification.

- Store `amount_min_cents` / `amount_max_cents`; `amount_exact_cents` only when
  the filing itself states a precise figure.
- The open-ended top bracket has `max = NULL`. A total containing one is
  reported as `≥floor` — never given an invented upper bound.
- `Volume` in `stats.py` and the `MID`/`sinceClause` helpers in
  `web/lib/queries.ts` both encode this. Keep them in agreement.

Likewise: reproduce what was filed. A few filings carry mistyped dates; the
parser stays faithful to the PDF and the UI flags the row rather than
"correcting" the data or rendering a nonsensical negative delay.

## Architecture notes

- `data/trades.sqlite3` is both pipeline state and knowledge base; the
  dashboard (`web/`, Next.js on Vercel) fetches it server-side with a short TTL
  and queries it with better-sqlite3.
- Filing status is a state machine (`src/whale/db.py`). Two details matter:
  `backfill_queued` is deliberately distinct from `new` so a backfill cannot
  swallow filings still owed a notification, and `notified_at` is separate from
  `status` so an unreadable filing can be reported once while staying
  re-parseable if a vision key is added later.
- `src/whale/ptr.py` parses by **word coordinates**, not reflowed text.
  `pdftotext`-style extraction runs adjacent columns together. Form labels
  carry `\x00` padding glyphs, which is how sub-field lines are detected.
- The cluster window is measured on **trade date** and defaults to 90 days
  because it must absorb the 45-day disclosure deadline. Over the full corpus
  (3,576 dated rows, 2026-10-17) the trade→filing delay is p50 25 / p90 ~80
  days, but that tail is a handful of year-long catch-up filings (450 rows
  exceed 45 days; five filings hold 379 of them). On 2026 trade dates alone it
  is p50 24 / p90 38. A 30-day window is only ever about half-populated.
- A cluster needs **both** `min_politicians` and `min_volume_usd`, and a member
  counts only if their bracket **floors** in the window sum to
  `min_member_floor_usd` (default $15,001: more than one lowest-bracket trade).
  83% of equity-like rows are $1,001–$15,000 and MSFT alone had 11 distinct
  buyers in 2026 filings, so participation without the floor is base rate.
  There is no single-member cluster; one large trade is that filing's own
  message. Members below the floor are named in the alert but never counted.
  Dedupe compares against the last alert's count only while that alert's own
  window (`fired_at + window_days`) still overlaps today's; the 33 alerts sent
  under the old rule recorded inflated counts, and they age out this way.
- Cluster alerts consider only equity-like asset types. Members roll Treasury
  bills constantly; one member alone filed 99 T-bill transactions in 2026.
- Senate eFD answers GitHub's US runners without a proxy (`ok: 100 filings
  seen` on 2026-10-17, #40); the "Akamai blocks datacenter IPs" story was
  never observed — every earlier run failed on an empty proxy string before
  reaching the site. What eFD does refuse is non-US addresses (a 403 on the
  agreement page itself). `SENATE_PROXY_URL` stays documented as a fallback
  for the day eFD refuses the runner, and must then be a *sticky* US proxy:
  the agreement is bound to the accepting IP. `senate.py` must still never
  raise into the pipeline. `sync_state.senate_status` is prefixed `ok:` /
  `blocked:` / `error:`; `blocked` is eFD refusing us (403, challenge page,
  the agreement form served where data belongs) and now *warns* in the audit
  with the proxy named as the fix; `error` is the request failing on our side
  (empty proxy URL, DNS, timeout) and warns separately. Blank environment
  secrets read as unset: GitHub Actions passes an undefined secret as `""`,
  which is how Senate went unattempted for every run while reading as the
  block (#16).
- Senate PTRs are eFD HTML pages, not PDFs. `src/whale/senate_ptr.py` reads
  the nine-column transactions table and emits `ptr.py`'s shapes, mapping the
  eFD vocabulary onto the House codes so nothing downstream learns the
  chamber: owner Self → NULL, Spouse → SP, Joint → JT, Dependent Child → DC;
  type Purchase → purchase, Sale (Full) → sale, Sale (Partial) →
  sale_partial, Exchange → exchange; asset type only where the meaning is the
  same (Stock → ST, Stock Option → OP, Corporate Bond → CS, Municipal
  Security → GS, Mutual Fund → MF, Exchange Traded Fund → EF …) — otherwise
  `asset_type` is NULL and the Senate label is kept in `description`, never a
  guessed code, because `cluster_asset_types` filters on it. Ticker `--` is
  NULL. Brackets go through `amounts.parse_amount`. The Comment column and
  the asset sub-detail (option strike/expiry, bond coupon/maturity) go in
  `description`; the nine cells joined by ` | ` in `raw_text`. No
  notification date or capital-gains box exists on the Senate form: both
  stay NULL. Senate dates are stored ISO; the rows indexed before the parser
  existed (MM/DD/YYYY, `year = 0`) are normalised idempotently by
  `pipeline._normalise_senate_rows` on every sync and backfill.
- A page without that exact table (an annual report, the agreement form, a
  template change) raises `SenateParseError` and the filing is `failed` with
  `parse_method = 'error'` — never "parsed, empty". **Paper Senate filings**
  (`/search/view/paper/<id>/`) are scanned page images: classified by URL,
  never fetched, `failed` with `parse_method = 'efd_paper'`, reported once
  through the unparsed message like a House scan, and never transcribed.
  The cluster window and asset-type filter are shared with the House by
  design: both chambers have the same 45-day deadline.
- **Disclosure delay is trade date -> filing date**, never the report's
  "Notification Date" column. Notification is when the *member* learned of the
  trade: someone trading their own account is notified same-day, so that column
  reads 0 however long the filing took, and using it halves the apparent
  lateness. Both are kept — `disclosure_delay_days` and `notification_lag_days`
  in `stats.py`, mirrored by `DELAY`/`LAG` in `web/lib/queries.ts`. Keep the
  Python and SQL definitions in agreement.
- Scanned-PDF transcription (`vision.enabled`) is **on since 2026-10-17**, and
  only because transcribed rows are quarantined from every volume figure,
  cluster and value floor (https://github.com/scheuclu/whale_tracker/issues/1, #42). It was off until that
  quarantine existed. The quarantine is the condition, not a detail: a
  transcribed row must never enter a total, and the grid reader, not the
  model, decides amount and type. Vision off plus a stored key is a
  legitimate state for debugging; the filings then wait as `failed`/`scanned`
  and are re-queued by `pipeline.retry_scanned` when it is turned back on.
  Model time per run is capped by `vision.budget_seconds` (480 s; scans past
  it stay `new` for the next run). The poll job's timeout is 20 minutes and
  the commit step is last, so an uncapped backlog is killed and commits
  nothing: the first run with vision on did exactly that with 53 scans
  (2026-10-17), and every scheduled run after it would have repeated it.
- The hybrid join (`vision.join`) is **per page** (#51): the model gives
  every row a page number, the grid knows its rows per page, and a page whose
  counts disagree is refused alone — its grid rows stored `page_refused`, its
  transcription dropped — while the rest of the filing is parsed, with a
  "partially read" note in `last_error` and the page's reason in
  `scan_pages.error`. A page the grid cannot decompose yields nothing the same
  way. A row whose model type contradicts the grid keeps the grid's type and is
  stored `type_disputed`; a page or filing is refused for disputes only past
  `MAX_DISPUTED_SHARE` with `MIN_DISPUTED_ROWS` (a quarter, and three: the
  model misreads a quarter of boxes, so fewer is noise — the three filings
  refused on day one had 2 of 6, 2 of 3 and 3 of 98, all the grid's call right
  by eye). `transactions` are linked to `scan_rows` by `row_index`, not by
  count. Refused scans (`vision_failed`) are re-queued **once per
  `vision.JOIN_VERSION`** (stamped in `sync_state`), so bump it when the join
  learns something and never retry them every run.
- Scanned paper filings are **captured for inspection** in the same database
  (`scan_pages`: one 1-bit PNG per page at 110 dpi, oriented the way
  `paper_form.py` turned it; `scan_rows`: every row the grid reader found,
  with column edges, ticked cells, margins and a link to the transaction when
  the hybrid path has made one). Same file, not a second one, because the
  dashboard fetches exactly one file and `poll.yml` commits exactly one — and
  that file is committed on every run, so the capture is budgeted at **15 MB**
  for the corpus (the 2026 scans are ~6 MB). `whale capture-scans` is the
  resumable catch-up; the pipeline captures each scan it meets. Nothing in
  these tables feeds a statistic; `/scans` is the audit trail.
- `src/whale/audit.py` powers the weekly self-review. Two standing rules: a
  check that fires every week on benign data is itself a defect (fix the check),
  and a check that raises must report `check_failed` rather than be swallowed —
  an unknown must never read as a pass. Real tickers collide with asset-type
  codes (ST is Sensata, AB is AllianceBernstein); do not "fix" that. There is
  deliberately no shape check on `insider_filings.ticker`: it comes from an XML
  element rather than a column split, and real values include exchange-prefixed
  foreign symbols like `ASX:LNW`.
- A ticker read from the asset name — `(BHP)` on a row whose ticker column
  is empty (#50) — is marked by appending `ptr.TICKER_FROM_NAME_NOTE` to
  `description`; that is the only provenance (no schema column) and
  `audit.check_tickers_from_asset_names` counts on it. On a House row only
  the form's own `(SYM) [XX]` slot counts, wherever it sits in the cell —
  `(THE)` and `(AMI) Labs` are not tickers; the Senate name column has no
  slot, so any single parenthesised symbol counts. Two different symbols
  mean no ticker. `pipeline._derive_tickers_from_names` re-derives stored
  rows on every sync and backfill, idempotently.
- Tests: `.venv/bin/python -m pytest -q` (run before every PR).

## Watchlist (per-member alerting)

- `watchlist` in `config.yaml` names members whose **every transaction** is its
  own alert. Empty or absent means the feature is off; `every_trade: false`
  keeps an entry documented but inert.
- A watched filing is **split per transaction** rather than sent through
  `telegram.format_filing`. That formatter degrades to fit Telegram's 4096
  characters — dropping context, then asset detail, then transactions — and a
  40-transaction filing is exactly when the truncation would hide the trade
  being watched for. Each message carries `transaction i of n` so the filing
  stays reconstructable.
- Watched filings **bypass `ingest.max_filing_age_days`** in `sync`. That
  cutoff stops a first run replaying a year of everyone's history; a member
  named explicitly is the case it is not protecting against. Still bounded by
  `ingest.years`.
- `bioguide_id` is authoritative and checked first; `name` is the fallback for
  a filing the roster failed to match, since an unmatched filing still carries
  the name printed on the PDF. A malformed `bioguide_id` raises `ConfigError`
  rather than falling through to the name match and looking like it worked —
  extend `WATCH_KEYS` when adding a key.
- The filing is marked notified only when **every** transaction was delivered,
  so a partial failure replays the whole filing. For a watched member a
  duplicate alert is a smaller harm than a missing one.
- Watched filings are sent **before** routine ones and must stay exempt from
  any batching or suppression added later — that exemption is the feature.

## SEC Form 4 (corporate insiders)

- Insider data lives in its own tables (`insiders`, `insider_filings`,
  `insider_filing_owners`, `insider_transactions`). Never join it into the
  politician tables or aggregates: every politician query filters on status
  alone, so shared tables would fold insider volume into member leaderboards.
- **Insider values are exact but computed**: `shares × price as filed`, stored
  with `min = max = exact`. A row with no price (or a zero price) has all three
  NULL — an unknown value is never 0. Filers may report a weighted-average
  price; the real range is only in the footnote text kept on the row. Label
  values "shares × reported price", never "disclosed range".
- Ingestion keeps only filings whose open-market `P`/`S` rows reach
  `insiders.min_trade_usd` in one direction, and only those rows. Rejected
  filings are not stored; `sync_state.edgar_cursor` is a per-filing watermark
  written oldest → newest, so an aborted run loses nothing and re-fetches
  nothing. Do not "fix" a stuck run by resetting the cursor — run
  `backfill-insiders` for the range instead.
- The feed caps at 2000 entries (~2 business days); the daily `form.idx` is the
  gap-free source. SEC allows 10 req/s and requires a contact e-mail in the
  User-Agent (`EDGAR_USER_AGENT`); undeclared clients get an HTML refusal page,
  sometimes with a 200. `edgar.EdgarClient` handles both; never bypass it.
- **`insider_transactions.late` is derived once in Python** (`stats.form4_is_late`:
  two business days, federal holidays excluded, from the deemed execution date
  when present). SQL reads the column and must not re-derive it — the holiday
  logic has no defensible SQL twin. Recompute with `backfill-insiders --recompute-late`.
- "Distinct insiders" always means primary reporting owners (`owner_index = 0`):
  a joint filing is one decision. Show filing counts next to insider counts.
- The insider cluster window is 30 days, not 90: Form 4 has a 2-business-day
  deadline, so there is no reporting lag to absorb.
- `4/A`, Forms 3/5 and the derivative table are not ingested yet (counted in
  `sync_state.edgar_skipped`).
- `insiders.sync` runs after every House and Senate step in `pipeline.run`
  and must never raise into it. Only issuer classification runs after it.

## Issuer classification (SIC sectors)

- `src/whale/issuers.py` (#55) resolves every ticker in `transactions` and
  every issuer CIK in `insider_filings` to an EDGAR SIC code, through
  `edgar.EdgarClient` only, and folds it into one of twelve groups. The
  SIC → group table is the module docstring; `_SIC_RANGES` is its code, and
  the two must stay in step.
- Two tables, schema 9: `issuers` is one row per CIK, `issuer_tickers` is
  symbol → CIK **including symbols EDGAR does not list** (cik NULL), so an
  unknown ticker is recorded as unknown and not looked up again before the
  weekly refresh. Both dashboard joins are one-to-one; a CIK with several
  symbols (BRK.A, BRK.B) is one issuer with two ticker rows.
- **Unknown stays unknown.** No SIC (ETF trusts, funds) → NULL group, never
  guessed from the name; an SIC outside every range → `Other`. Sector views
  show the unclassified remainder as a row of its own so groups never sum
  to more than they describe. A sector is a label on a row, never a figure:
  it must not enter any volume arithmetic.
- The fill runs **last** in `pipeline.run`, after the insider alerts, under
  `issuers.budget_seconds`, never-fetched issuers first, committed per
  issuer, and never raises; `whale classify-issuers --budget-seconds N` is
  the manual form. A failed refresh keeps the earlier classification.
- The dashboard reads whatever database the pipeline last committed, which
  may predate the migration, so every sector query goes through
  `hasIssuerTables` and reports nothing rather than "no such table".

## Insider alerts

- Alerts fire only from the user's rules in `insiders.alerts`. **No rules means
  no alerts**, and `insiders.ingest_status` then stores every filing as
  `backfilled` — nothing may enter the `parsed` queue that nothing can drain.
- Rules are tried **in order and the first match wins**, so a general rule
  placed above a specific one silently swallows it. Keep the specific ones
  first in `config.yaml`, and in any example.
- An unknown rule key or value raises `ConfigError` at load. That is
  deliberate: a typo'd condition that never matches is exactly the silent
  failure this project exists to avoid. Extend `RULE_KEYS` when adding one.
- A rule's value floor is compared against the summed value of **one
  direction** within **one filing**, and an unpriced direction can never clear
  it — an unknown value is not a large one.
- `roles`/`titles` are satisfied by any one reporting owner on the filing (a
  joint filing is one economic act), but a single owner must satisfy both when
  both are given. Cluster rules reject them: they describe one filer.
- Insider cluster dedupe lives in `alerts` with `kind='insider_cluster'`;
  `db.last_alert` **must** be called with a kind, or a congressional cluster on
  a ticker suppresses an insider one. `alerts.politician_count` holds whichever
  participant count the kind counts. It orders by `fired_at DESC, id DESC`:
  `fired_at` is second-resolution, and a tie read the wrong way re-sends a
  cluster already reported at its current size.
- **One convergence is one message.** `pipeline.notify_insiders` settles
  clusters *first* and then suppresses any pending filing whose
  `(issuer_cik, direction)` a reported cluster already covers — folding it to
  history rather than dropping it, so the dashboard still counts it. Without
  this a coordinated purchase reports itself twice over: Banco Bradesco's
  board sent 21 individual alerts plus 4 cluster alerts for one event. A
  cluster whose *delivery failed* must stay uncovered, or its members vanish
  into a message that was never sent.
- An insider cluster re-fires only when it is `cluster_refire_growth`× the
  size last reported (default 1.5), not on every extra insider. Form 4's
  two-business-day deadline makes one event arrive as a burst over a day or
  two, so +1 insider per poll is the normal shape of a single decision. The
  congressional side keeps the plain `> previous` rule — a 45-day deadline
  spreads those filings out, so there is no burst to damp.
- A `--dry-run` must not demote, notify or record anything: previewing the
  queue never consumes it. `whale insider-alerts` is the tuning tool and
  ignores notification state so rules can be tested against history.
- **Filing rules have a per-owner cooldown** keyed on (primary owner CIK,
  issuer CIK, direction) and stored in `insider_alert_cooldowns`, not in
  `alerts` (no owner column; its key must stay the cluster dedupe). A repeat
  inside `insiders.filing_refire_days` is folded to history, like a cluster
  member, and re-fires only when the run's cumulative value is
  `cluster_refire_growth`× what was last reported — Nippon Life / CRBG was 24
  alerts for one programme. Only a *delivered* alert writes the state, so a
  failed send is judged afresh next run. The congressional watchlist is a
  different mechanism and stays exempt from this and any other suppression.

## Alert log (`/alerts`)

- `alerts` is **one row per message sent**, of every kind (`stats.ALERT_KINDS`:
  `cluster`, `insider_cluster`, `filing`, `watchlist`, `insider_filing`,
  `options`), and still the dedupe store for the two cluster kinds. A new
  delivery path must log its messages or `audit.check_alert_recording` will
  name the filing. `db.last_alert` **must**
  keep being called with a kind. `politician_count` holds whatever the kind
  counts; a watched filing logs one row per transaction because each is its
  own message.
- Log **only on delivery, never on `--dry-run`**, in the same commit as
  `mark_notified`. A failed send leaves no row; a replayed watchlist filing
  logs its repeats, because the log describes what was sent, not what was
  meant.
- `ticker`/`direction` are NULL when the alert is not about one ticker in one
  direction (a filing spanning several, a Treasury roll with none). Volume is
  the disclosed range plus the midpoint estimate; insider values `min = max`;
  all NULL when nothing was priced or read. `message` is the Telegram text
  **as sent** — the dashboard strips its HTML and never re-renders one.
- Schema 13 rebuilt the table (SQLite cannot relax NOT NULL in place); rows
  before it carry only the dedupe fields and the page says so. The web
  queries in `web/lib/alert-queries.ts` **tolerate the pre-13 shape**: the
  dashboard reads the committed database, which migrates only when the
  pipeline next runs, so a query assuming the new columns would take the page
  down in between. `sync_state.alerts_recorded_since` marks the switch.
- Audit `check_alert_recording` keys on `status = 'notified'`, not
  `notified_at` — backfills set `notified_at` silently to mean "never
  announce".

## Data-viz

Charts are pure CSS/SVG in `web/app/charts.tsx`; no chart library. Colour roles
live in `--viz-*` at the bottom of `web/app/globals.css`.

Buy/sell uses a **blue↔red diverging pair, not the finance-convention
green/red**. Green/red measures a CVD ΔE of 4.1 under deuteranopia against
these surfaces — red-green colourblind readers cannot separate them. Blue/red
measures 23.8 light / 19.2 dark. Direction is always spelled out in text too,
so colour never carries meaning alone. Re-run the validator in the `dataviz`
skill before changing any palette value.

## Dashboard conventions

- Vercel builds a preview for every PR — point the user at it for UI review.
- Verify `cd web && npm run build` passes and render the pages headless before
  opening a PR; say what was checked.
- Summary stat tiles must aggregate over the whole dataset, not the rendered
  page slice (see `getPoliticianTotals`) — summing a truncated list understates
  the total it claims to report.
