# Project instructions

## Name: FatCat Watch, code says `whale`

The product is **FatCat Watch** at https://www.fatcatwatch.com (formerly
Whale Tracker). User-facing copy uses the new name (`SITE_NAME` in
`web/lib/site.ts`, re-exported by `web/lib/methodology.ts`; the wordmark in
`web/app/brand.tsx`, the mark in `web/lib/brand.ts`); code identifiers keep
`whale` — the package, `python -m whale`, the repo, workflow and DB names,
env vars. Do not rename those. Keep the tone playful, never accusatory: a
disclosed trade is not evidence of wrongdoing. The apex → www and the old
`whaletracker-blue.vercel.app` → www 308s live in Vercel → Project →
Domains, not in code.

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
  and queries it with better-sqlite3. The re-check is a conditional GET (the
  blob's ETag), so an unchanged file is a 304, not an 18 MB download.
- **Dashboard staleness bound: 120 s** after the pipeline's commit lands, the
  same bound the old 120 s DB TTL gave. Pages render per request (they read
  `searchParams`) but `next.config.ts` adds `CDN-Cache-Control` so Vercel's CDN
  holds each URL (query string and Next's `Vary` headers in the key) briefly:
  DB re-check 30 s + CDN 60 s + stale-while-revalidate 30 s, all in
  `web/lib/cache-policy.ts`, whose test fails if the sum exceeds 120 s.
  Raising any term means stating the new bound. Text computed from the clock
  at render time can trail by that much: the header's "synced X ago" is
  recomputed in the browser (`app/live-relative-time.tsx`). `/api/*` routes
  set their own headers and are excluded.
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
- Committee seats (`committees`, `committee_members`) come from the same
  congress-legislators dataset as the roster and are refreshed inside
  `roster.sync`. They are a snapshot of the *current* Congress with no
  history, so a refresh replaces both tables wholesale in one transaction
  that rolls back on a bad fetch, keeping the previous snapshot; a seat whose
  bioguide id is not in `politicians` is dropped and counted, never invented.
  Subcommittees are `committees` rows with `parent_id`, keyed
  `<parent><two-digit code>` (`HSIF16`) the way the membership file keys
  them. The web queries guard on the tables existing: the committed database
  gains a new schema version only on the pipeline's next run after a merge.
- Tests: `.venv/bin/python -m pytest -q` (run before every PR).
- Dashboard tests: `cd web && npm test` (unit tests in `lib/*.test.ts`,
  every query against the committed database) and the Playwright e2e suite
  in `web/e2e/` against a production build:
  `cd web && NEXT_PUBLIC_SITE_URL=http://localhost:3245 npm run build && npm run test:e2e`
  (the origin is inlined at build time and the canonical checks compare
  against it; the config starts `next start` on port 3245, or reuses a
  server already there). Both run in CI (`.github/workflows/web.yml`) on
  every PR touching `web/**` or the database, and daily on main; a failed
  run uploads the HTML report and traces as an artifact. A new page or
  route is one line in `web/e2e/routes.ts`. Known bugs are pinned with
  `test.fail` and a note — remove the annotation when the fix lands, since
  the test then fails as "unexpectedly passed".

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
- `insiders.sync` runs after every congressional step in `pipeline.run` and
  must never raise into it; only the price step (`prices.sync`, #53) and the
  issuer classification (#55) run after it, under the same rule.

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

## Alert outcomes (`prices`, `alert_outcomes`, the /alerts summary)

- `prices` holds daily closes for the tickers alerts have named plus SPY,
  from an **unofficial external series** (`prices.source`: `yahoo` default,
  `stooq` per issue #53 — walled by a browser check on 2026-10-18, reported
  as `blocked`, never solved). It exists for one descriptive measurement and
  is **never shown as advice**. Coverage is what the source carries: no
  series for CIK-keyed insider alerts, exchange-prefixed foreign symbols or
  anything the source does not know; those alerts read "no prices yet" or
  "no price series", not 0.
- An outcome is the **ticker's move, not a trade's return**: close(t0+h) /
  close(t0) − 1 at h = 5/20/60 trading days, minus SPY over the same
  sessions. No bracket, midpoint or position enters it. t0 is the first
  session on or after the alert's **US-Eastern** date (an 02:00Z alert went
  out the previous evening), so an alert sent after the close measures from
  that close and includes the next open's reaction. The calendar is SPY's
  own series, so holidays fall out without a calendar of their own.
- **Derived once in Python** (`stats.alert_outcomes`), stored by
  `prices.sync` after every refresh, and only **read** by SQL and
  `web/lib/outcome-queries.ts`. The aggregate (median signed excess, hit
  rate, n per kind and horizon) is computed twice — `stats.outcome_summary`
  and `summarize` in the web query — on the same stored rows; both are
  tested against the same hand-made fixture. A sell alert's hit is a fall
  (`signed_excess`); an alert with no one direction is excluded. Under
  `MIN_OUTCOME_SAMPLE` (5, mirrored as `MIN_SAMPLE`) a figure is
  "insufficient data", never a number.
- A horizon the series does not reach yet is NULL and reads "pending", not
  0; a session's close is stored only after 16:05 ET. Each ticker is
  refreshed once per UTC day under `prices.budget_seconds`, benchmark first
  then longest-unseen, so a throttle rotates through the list. The web
  queries tolerate a database without the tables (the committed file
  migrates only when the pipeline next runs).
- Audit: `check_price_coverage` (INFO, right after `check_alert_recording`)
  reports alerts with a t0 close over all alerts and the source status;
  `prices_stale` WARNs only when a ticker has had no newer close for more
  than 5 trading days **and** the step has not successfully asked for it
  since — a series the source answered for with nothing newer (a buyout)
  is evidence, not a weekly warning.

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
  `options`), and still the dedupe store for the two cluster kinds. The
  `late_filing` row (#57) is **not** a message kind: it is a marker recorded
  beside the filing's own `filing` row, and `web/lib/alert-queries.ts` leaves
  it out so the page never lists one message twice. A new delivery path must
  log its messages or `audit.check_alert_recording` will name the filing. `db.last_alert` **must**
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

## Agent/LLM access

- `/api/v1` (JSON, `web/lib/api-v1.ts`), `/llms.txt`, `/llms-full.txt`,
  `/openapi.json` and the human `/methodology` page all render from **one
  module**, `web/lib/methodology.ts`: the quoting rules, sources, known gaps,
  the data dictionary and the endpoint list. Never restate a rule in one
  surface; change it there. The rules restate the data rules above
  (brackets, open-ended `≥floor`, midpoints labelled estimates, transcription
  quarantine, delay = trade → filing date, Form 4 = shares × reported price,
  insider data never combined) — when a data rule changes, change the
  module in the same PR.
- Every amount leaves the API as `{ kind, min_usd, max_usd, exact_usd,
  disclosed, midpoint_estimate_usd }` (`api-format.ts`), every total as a
  `Volume` built from the query layer's own `volume_min/max/mid`. The API
  reuses `queries.ts` / `insider-queries.ts` and the feed's filter parser;
  it must not re-derive a definition. `lib/api.test.ts` checks API totals
  against the pages'.
- Parameters are whitelisted per endpoint (`PARAMS`): unknown keys and
  malformed values are 400s, `limit` clamps at 500 and says so in
  `meta.notices`. `/openapi.json` is generated from the same `PARAMS`.
- Absolute URLs come from `web/lib/site-url.ts` (`NEXT_PUBLIC_SITE_URL` →
  `VERCEL_PROJECT_PRODUCTION_URL` → request origin), never a deployment URL;
  page links in API objects come from `memberHref` / `tickerHref`.

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
  opening a PR (`npm run test:e2e` covers every main route); say what was
  checked.
- Summary stat tiles must aggregate over the whole dataset, not the rendered
  page slice (see `getPoliticianTotals`) — summing a truncated list understates
  the total it claims to report.
- **Entity URLs** are `/members/<name-slug>-<bioguide>` (name alone for an
  unmatched filer; the id makes the URL survive a respelling) and
  `/tickers/<SYMBOL>`. Build every link with `memberHref(name, bioguideId)` /
  `tickerHref` in `web/lib/format.ts` — pass the bioguide id, or the link costs
  a redirect — and keep `member_page_url` in `src/whale/telegram.py` in
  agreement (both slug functions are pinned by tests). The legacy
  `?m=`/`?member=`/`?t=` URLs get a real 308 from `app/api/legacy-redirect`
  via `next.config.ts` rewrites; a page cannot do it, because every page
  streams behind `app/loading.tsx` and a `redirect()`/`notFound()` there goes
  out as a 200 with a meta refresh / `noindex`.
- **Metadata**: every page sets title, description and canonical through
  `pageMetadata` (`web/lib/seo.ts`); sorted/filtered/paged variants
  canonicalise to the base page, `/search` and `/scans/<doc>` are `noindex,
  follow`. Absolute URLs come from `NEXT_PUBLIC_SITE_URL` (the public domain,
  never a deployment URL). Metadata, share cards and JSON-LD follow the range
  rules like any other surface: counts or disclosed ranges, never a midpoint.
- Caching must never key one page's data under another URL: rely on the
  CDN's full-URL key, never a cache that ignores `searchParams`. A new page
  gets the CDN header automatically (`PAGE_SOURCE` in `lib/cache-policy.ts`);
  a new route handler opts in by sending `PAGE_CDN_CACHE_CONTROL` itself.
- The page-in fade (`.site-header + main > *`) plays on client navigations,
  not on the document's first paint (`data-first-load`, `header-shell.tsx`):
  holding first-load content at opacity 0 delayed LCP by ~0.2 s real, ~1 s in
  Lighthouse's mobile model.
- **Security headers** (CSP, HSTS, framing, nosniff, referrer, permissions)
  are set on every path from `web/lib/security-headers.ts`. The CSP allows
  inline scripts on purpose: a nonce cannot survive the CDN page cache (a
  cached page replays one nonce), and the App Router's inline RSC payload
  cannot be hashed. Everything else is locked to `'self'`; the only
  third-party origins are the admin sign-in redirect in `form-action`, plus
  dev/preview-only allowances. A new third-party origin (script, embed,
  client-side fetch, font) is a deliberate CSP change in that file, with
  `/privacy` updated in the same PR — never a wildcard.
- **`/privacy` must describe what the code does.** Any change to what the site
  collects or who processes it (a new script, stored field, cookie or vendor)
  updates `web/app/privacy/page.tsx` and `PRIVACY_UPDATED` (`web/lib/legal.ts`)
  in the same PR. `/terms` restates the methodology's rules (not advice, not
  evidence of wrongdoing, as filed) and must never contradict
  `web/lib/methodology.ts`.
- **`/api/health`** is for uptime monitors: 200 `ok` / 503 `degraded`, never
  cached, no error text. Freshness is judged on the last pipeline write
  (`MAX(sync_state.updated_at)`, written by every run) against
  `STALE_AFTER_HOURS` (12, shared with the header's sync pill;
  `HEALTH_STALE_AFTER_HOURS` overrides it), not on the last filing change,
  which is legitimately old on a quiet day; two failed runs in a row also
  degrade it. Error text shown to readers goes through `publicErrorMessage`
  (`web/lib/public-error.ts`): no paths, credentials or stacks.

## Late-filing compliance

- A filing is "late" for the prefix and the `late_filing` alert only when
  **every** trade is past `alerts.late_filing_days` (`stats.filing_late_by_days`).
  N is the longest delay minus the deadline — the report was due that many days
  after its earliest trade. A row with an unknown delay (contradictory dates)
  disqualifies the filing rather than being skipped; 0 turns both off.
- The prefix is the first line of the existing filing message, never a second
  message, and survives every degradation step of `format_filing` and
  `format_filing_summary`. Watched filings are split per transaction and do not
  carry it.
- A `late_filing` row is keyed the way `filings` is unique: `ticker` =
  document id, `direction` = chamber, `window_days` = the deadline used,
  `politician_count` = late trades (the keying predates schema 13's
  `filing_id` and the dedupe still reads it). It is recorded only after
  delivery, once per filing (`stats.is_new_late_filing`, kind-scoped), never
  on a dry run, and is a marker rather than a message — see *Alert log*.
- The dashboard's `?view=late` queries (`LATE` in `web/lib/queries.ts`) must
  reconcile with `getPoliticianTotals` — `web/lib/late.test.ts` asserts it on
  the committed DB. The monthly series is by month of *filing*: by trade month
  the recent months always look cleaner than they are.
- `audit.check_late_filings` (INFO) lists the week's filings with late trades;
  it reuses `stats.disclosure_delay_days` so it cannot drift from the prefix.
