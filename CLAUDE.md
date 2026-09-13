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
  because it must absorb the 45-day disclosure deadline. In the 2026 corpus the
  observed lag is a median of 17 days, p90 of 33 — a 30-day window is only ever
  about half-populated.
- Cluster alerts consider only equity-like asset types. Members roll Treasury
  bills constantly; one member alone filed 99 T-bill transactions in 2026.
- Senate is expected to fail. `senate.py` must never raise into the pipeline.
- **Disclosure delay is trade date -> filing date**, never the report's
  "Notification Date" column. Notification is when the *member* learned of the
  trade: someone trading their own account is notified same-day, so that column
  reads 0 however long the filing took, and using it halves the apparent
  lateness. Both are kept — `disclosure_delay_days` and `notification_lag_days`
  in `stats.py`, mirrored by `DELAY`/`LAG` in `web/lib/queries.ts`. Keep the
  Python and SQL definitions in agreement.
- Scanned-PDF transcription is off by default and must stay that way until
  vision rows are quarantined from the statistics (https://github.com/scheuclu/whale_tracker/issues/1). Do not flip
  `vision.enabled` to close a coverage gap.
- Tests: `.venv/bin/python -m pytest -q` (run before every PR).

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
  `sync_state.edgar_skipped`). Kept filings enter as `backfilled` until insider
  alerts exist; the alerts PR flips recent filings to `parsed` at ingest.
- `insiders.sync` runs **last** in `pipeline.run` and must never raise into it.

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
