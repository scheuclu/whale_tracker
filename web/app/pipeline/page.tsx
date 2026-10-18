import { getPipeline, medianGapHours, type PipelineRun } from "@/lib/queries";
import { getInsiderPipeline } from "@/lib/insider-queries";
import { getAlertTotals, KIND_LABEL, type AlertKind } from "@/lib/alert-queries";
import { duration, relativeTime } from "@/lib/format";
import { Card, Empty, SectionTitle, StatTile } from "../charts";
import { Disclosure } from "../disclosure";
import { HealthPill, DataError, PAGE_STACK, PageHeader, Quiet, type Health } from "../page-header";
import { ResponsiveTable, StatusBadge } from "../ui";

export const dynamic = "force-dynamic";

export default async function PipelinePage() {
  let p, ins, alerts;
  try {
    [p, ins, alerts] = await Promise.all([getPipeline(), getInsiderPipeline(), getAlertTotals()]);
  } catch (err) {
    return <DataError error={err} />;
  }

  const senate = senateHealth(p.senateStatus);
  const edgar = edgarHealth(ins ? ins.state.edgar_status ?? null : undefined, ins?.state.edgar_cursor ?? null);
  const skipped = parseSkipped(ins?.state.edgar_skipped ?? null);
  const readable = p.coverage.parsed + p.coverage.unreadable;
  const readablePct = readable ? Math.round((p.coverage.parsed / readable) * 100) : 0;

  return (
    <div className={PAGE_STACK}>
      <PageHeader
        title="Pipeline"
        subtitle="Where the data comes from, how much of it could be read, and what each run did."
      >
        <section aria-label="Pipeline totals" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile label="Filings indexed" value={p.totals.filings.toLocaleString()} />
          <StatTile label="Trades parsed" value={p.totals.transactions.toLocaleString()} />
          <StatTile label="Readable" value={`${readablePct}%`} hint={`${p.coverage.unreadable} scans unread`} />
          <StatTile label="Last run" value={relativeTime(p.lastUpdated)} />
        </section>
      </PageHeader>

      <section aria-labelledby="coverage-title">
        <SectionTitle right={<span className="text-[12px] text-muted-foreground">three sources</span>}>
          <span id="coverage-title">Coverage</span>
        </SectionTitle>
        <Card className="p-0 sm:p-0">
          <ul className="divide-y divide-border/70">
            <Source
              name="US House"
              health="ok"
              state="Full coverage"
              description="Periodic transaction reports from the Clerk’s bulk disclosure index, parsed directly from the filed PDFs."
            />
            <Source
              name="US Senate"
              health={senate.health}
              state={senate.state}
              sentence={senate.sentence}
              raw={p.senateStatus}
              description={
                <>
                  Periodic transaction reports from the eFD search, parsed from each electronic report page
                  into the same table as House trades. Paper filings are scanned images and are listed as
                  unreadable.
                </>
              }
            >
              {senate.health === "attention" ? (
                <p className="text-[13px] text-attention">
                  The last attempt did not reach the report list, so no new Senate filings are being added
                  until it does.
                </p>
              ) : null}
            </Source>
            <Source
              name="SEC Form 4 insiders"
              health={edgar.health}
              state={edgar.state}
              sentence={edgar.sentence}
              raw={
                ins
                  ? `${ins.state.edgar_status ?? "no run recorded"}${
                      ins.state.edgar_cursor ? ` · cursor ${ins.state.edgar_cursor}` : ""
                    }`
                  : null
              }
              description={
                <>
                  Corporate officers, directors and 10% owners, from EDGAR&rsquo;s live feed. Only filings
                  with open-market buys or sells of $50k+ in one direction are stored; grants, option
                  exercises, tax withholding and gifts are not. Amendments (4/A) and the derivative table
                  are not ingested yet.
                </>
              }
            >
              {skipped ? (
                <p className="text-[13px] text-muted-foreground">
                  Skipped on the last run:{" "}
                  {Object.entries(skipped)
                    .map(([k, v]) => `${v.toLocaleString()} ${SKIP_LABEL[k] ?? k}`)
                    .join(", ")}
                  .
                </p>
              ) : null}
              {ins?.state.edgar_gap ? (
                <p className="text-[13px] text-attention">
                  Feed gap {ins.state.edgar_gap} — each run walks the daily index for it until it clears
                  (progress in the status above); to finish by hand:{" "}
                  <code className="break-all font-mono text-[12px]">
                    backfill-insiders --from {ins.state.edgar_gap.split("..")[0]} --to{" "}
                    {ins.state.edgar_gap.split("..")[1]}
                  </code>
                </p>
              ) : null}
              {ins?.state.edgar_backfill_through ? (
                <p className="text-[13px] text-muted-foreground">
                  Daily-index history loaded through {ins.state.edgar_backfill_through}.
                </p>
              ) : null}
            </Source>
          </ul>
        </Card>
      </section>

      <section className="grid gap-x-6 gap-y-7 lg:grid-cols-2">
        <div>
          <SectionTitle>Filings by status</SectionTitle>
          <Card className="space-y-2">
            {p.byStatus.map((s) => (
              <div key={`${s.chamber}-${s.status}`} className="flex items-center gap-3 text-[13px]">
                <StatusBadge value={s.status} />
                <span className="text-xs text-muted-foreground">{s.chamber}</span>
                <div className="flex-1" />
                <span className="tabular font-medium">{s.n.toLocaleString()}</span>
              </div>
            ))}
            {ins?.byStatus.map((s) => (
              <div key={`insider-${s.status}-${s.source}`} className="flex items-center gap-3 text-[13px]">
                <StatusBadge value={s.status} />
                <span className="text-xs text-muted-foreground">
                  form 4 · {s.source === "index" ? "daily index" : "live feed"}
                </span>
                <div className="flex-1" />
                <span className="tabular font-medium">{s.n.toLocaleString()}</span>
              </div>
            ))}
            {ins ? (
              <p className="border-t border-border/70 pt-3 text-[12px] leading-relaxed text-muted-foreground">
                Form 4 filings enter as history until insider alerts exist; {ins.totals.trades.toLocaleString()}{" "}
                open-market trades across {ins.totals.issuers.toLocaleString()} issuers are stored.
              </p>
            ) : null}
          </Card>
        </div>

        <div>
          <SectionTitle
            right={
              <a href="/scans" className="text-[12px] text-muted-foreground underline-offset-2 hover:text-primary hover:underline">
                inspect scans
              </a>
            }
          >
            How filings were read
          </SectionTitle>
          <Card className="space-y-2">
            {p.byMethod.map((m) => (
              <div key={m.parse_method} className="flex items-center gap-3 text-[13px]">
                <span className="font-medium">{METHOD_LABEL[m.parse_method] ?? m.parse_method}</span>
                <div className="flex-1" />
                <span className="tabular text-muted-foreground">{m.n.toLocaleString()}</span>
              </div>
            ))}
            <Disclosure
              size="sm"
              className="border-t border-border/70 pt-3"
              summary="About paper filings"
              lead={
                p.transcribed.filings
                  ? `${p.transcribed.filings.toLocaleString()} scanned filing${p.transcribed.filings === 1 ? "" : "s"} ` +
                    `(${p.transcribed.rows.toLocaleString()} rows) were transcribed: text by a vision model, ` +
                    "ticked boxes by the grid reader. Those rows are labelled on every page and count as " +
                    "trades, but enter no volume total, cluster or floor."
                  : "No filing has been transcribed from a scan: transcription is off (vision.enabled)."
              }
            >
              <p>
                Members of either chamber may file on paper. Those filings arrive as image-only scans — a PDF
                with no text layer from the House, page images on eFD from the Senate; without a vision model
                configured they are reported to Telegram with a link but contribute no transactions to the
                totals.
              </p>
              <p>
                Every scanned filing, captured or not, with what the grid reader saw on each page:{" "}
                <a href="/scans" className="underline underline-offset-2 hover:text-primary">
                  inspect scans
                </a>
                .
              </p>
            </Disclosure>
          </Card>
        </div>
      </section>

      <section aria-labelledby="alerts-sent-title">
        <SectionTitle
          right={
            <a
              href="/alerts"
              className="text-[12px] text-muted-foreground underline-offset-2 hover:text-primary hover:underline"
            >
              every alert, with its message
            </a>
          }
        >
          <span id="alerts-sent-title">Alerts sent</span>
        </SectionTitle>
        <Card className="space-y-1.5">
          <p className="text-[14px]">
            <span className="tabular font-medium">
              {alerts.total ? `${alerts.total.toLocaleString()} alerts logged` : "No alert has fired yet"}
            </span>
            {alerts.last_fired ? (
              <span className="text-muted-foreground"> · last {relativeTime(alerts.last_fired)}</span>
            ) : null}
          </p>
          {alerts.byKind.length ? (
            <p className="tabular text-[13px] text-muted-foreground">
              {alerts.byKind
                .map((k) => `${k.total.toLocaleString()} ${(KIND_LABEL[k.kind as AlertKind] ?? k.kind).toLowerCase()}`)
                .join(" · ")}
            </p>
          ) : null}
          <p className="max-w-[68ch] text-[12px] leading-relaxed text-muted-foreground">
            {alerts.recorded_since
              ? `Every alert sent since ${alerts.recorded_since.slice(0, 10)} is logged with its participants, ` +
                "disclosed range and message text; earlier rows kept only the cluster dedupe fields."
              : "Only the cluster dedupe rows are logged until the pipeline next runs on schema 13; " +
                "from then on every kind is, with its message text."}{" "}
            <a href="/alerts" className="underline underline-offset-2 hover:text-primary">
              Open the alert log
            </a>
            .
          </p>
        </Card>
      </section>

      {ins?.failures.length || p.failures.length ? (
        <section aria-labelledby="unreadable-title">
          <SectionTitle
            right={
              <span className="tabular text-[12px] text-muted-foreground">
                {[
                  p.failures.length ? `${p.failures.length} disclosure${p.failures.length === 1 ? "" : "s"}` : null,
                  ins?.failures.length ? `${ins.failures.length} Form 4${ins.failures.length === 1 ? "" : "s"}` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            }
          >
            <span id="unreadable-title">Unreadable filings</span>
          </SectionTitle>
          <Card className="p-0 sm:p-0">
            <ul className="divide-y divide-border/70">
              {p.failures.map((f) => (
                <Failure key={f.doc_id} href={f.pdf_url} id={f.doc_id} who={f.filer_name} error={f.last_error} />
              ))}
              {ins?.failures.map((f) => (
                <Failure
                  key={f.accession}
                  href={f.source_url}
                  id={f.accession}
                  who={f.issuer_name ?? "unknown issuer"}
                  error={f.last_error}
                  tag="Form 4"
                />
              ))}
            </ul>
          </Card>
        </section>
      ) : null}

      <section aria-labelledby="runs-title">
        <SectionTitle>
          <span id="runs-title">Recent runs</span>
        </SectionTitle>
        {p.runs.length ? (
          <ResponsiveTable>
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-border text-left text-[12px] font-medium text-muted-foreground">
                  <th className="px-4 py-2.5 font-medium">Started</th>
                  <th className="px-4 py-2.5 font-medium">Took</th>
                  <th className="px-4 py-2.5 text-right font-medium">Parsed</th>
                  <th className="px-4 py-2.5 text-right font-medium">Alerts</th>
                  <th className="px-4 py-2.5 text-right font-medium">Scans</th>
                  <th className="px-4 py-2.5 text-right font-medium">Form 4s</th>
                  <th className="px-4 py-2.5 font-medium">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {p.runs.map((r) => (
                  <tr key={r.started} className="border-b border-border/50 last:border-0">
                    <td className="px-4 py-2">
                      <span title={r.started}>{relativeTime(r.started)}</span>
                      <span className="ml-2 font-mono text-[11px] text-muted-foreground">
                        {r.started.slice(0, 16).replace("T", " ")}
                      </span>
                    </td>
                    <td className="tabular px-4 py-2">{duration(r.duration_s)}</td>
                    <td className="tabular px-4 py-2 text-right">{r.filings_parsed}</td>
                    <td className="tabular px-4 py-2 text-right">{r.alerts_sent}</td>
                    <td className="tabular px-4 py-2 text-right">{r.scans_transcribed}</td>
                    <td className="tabular px-4 py-2 text-right">{r.insiders_stored}</td>
                    <td className="px-4 py-2">
                      <span className="inline-flex items-center gap-2">
                        <HealthPill health={r.outcome === "ok" ? "ok" : "error"} title={r.outcome}>
                          {r.outcome === "ok" ? "ok" : r.outcome}
                        </HealthPill>
                        {r.error ? (
                          <span className="max-w-[28rem] truncate font-mono text-[11px] text-muted-foreground" title={r.error}>
                            {r.error}
                          </span>
                        ) : null}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ResponsiveTable>
        ) : (
          <Quiet>
            No run has written the log yet — it starts with the first scheduled run after this version of
            the pipeline is deployed.
          </Quiet>
        )}
        <Disclosure
          size="sm"
          className="mt-3"
          lead={`A run is scheduled every 90 minutes on paper; GitHub delivers scheduled runs late and drops some under load.${cadenceNote(p.runs)}`}
        >
          <p>
            Columns: filings parsed (House and Senate), Telegram alerts sent, scans transcribed by the vision
            model, Form 4 filings stored (live feed and gap repair). Dry runs and runs killed by the job
            timeout leave no entry; the GitHub Actions history has those.
          </p>
          <p>
            Cadence: scheduled at :17 past every third hour and :47 past the hours between (UTC), a run every
            90 minutes on paper. GitHub delivers scheduled runs late and drops some under load — on the
            earlier single three-hourly schedule the gap between runs was a median 5.3 h (p90 8.5 h, max
            10.6 h) over 100 runs.
          </p>
        </Disclosure>
      </section>
    </div>
  );
}

/**
 * One source in the coverage list: its name and a state pill, the last run
 * in a plain sentence, what the source is, and any notes. The raw status
 * string the pipeline wrote stays one click away for debugging.
 */
function Source({
  name,
  health,
  state,
  sentence,
  raw,
  description,
  children,
}: {
  name: string;
  health: Health;
  state: string;
  sentence?: string | null;
  raw?: string | null;
  description: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <li className="px-4 py-4 sm:px-5" data-source={name}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <h3 className="text-[14px] font-semibold">{name}</h3>
        <HealthPill health={health} title={raw ?? undefined}>
          {state}
        </HealthPill>
        {sentence ? <span className="tabular text-[13px] text-ink-2">{sentence}</span> : null}
      </div>
      <div className="mt-1.5 max-w-[68ch] space-y-1.5">
        <p className="text-[13px] leading-relaxed text-muted-foreground">{description}</p>
        {children}
      </div>
      {raw ? (
        <Disclosure size="sm" summary="Raw status" className="mt-1.5">
          <code className="block break-words font-mono text-[11px]">{raw}</code>
        </Disclosure>
      ) : null}
    </li>
  );
}

function Failure({
  href,
  id,
  who,
  error,
  tag,
}: {
  href: string;
  id: string;
  who: string;
  error: string | null;
  tag?: string;
}) {
  return (
    <li className="px-4 py-2.5 sm:px-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[13px]">
        <span className="font-medium">{who}</span>
        {tag ? (
          <span className="rounded bg-muted px-1.5 py-px text-[10px] text-muted-foreground">{tag}</span>
        ) : null}
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="min-w-0 break-all font-mono text-[11px] text-muted-foreground hover:text-primary"
        >
          {id}
        </a>
      </div>
      {error ? (
        <p className="mt-0.5 truncate text-[12px] text-muted-foreground" title={error}>
          {error}
        </p>
      ) : null}
    </li>
  );
}

/** "ok: 100 filings seen" → Live · "100 filings seen on the last run". */
function senateHealth(status: string | null): { health: Health; state: string; sentence: string | null } {
  if (!status) return { health: "off", state: "Not yet attempted", sentence: null };
  if (status.startsWith("ok")) {
    const detail = status.replace(/^ok:?\s*/, "");
    return { health: "ok", state: "Live", sentence: detail ? `${detail} on the last run` : null };
  }
  return { health: "attention", state: "Attention", sentence: null };
}

/**
 * "ok: 0 stored / 1 seen" plus the cursor → Live · "1 filing seen on the
 * last run, 0 stored · newest filing read 2d ago". `undefined` means the
 * insider tables do not exist; `null`, that no run has recorded a status.
 */
function edgarHealth(
  status: string | null | undefined,
  cursor: string | null
): { health: Health; state: string; sentence: string | null } {
  if (status === undefined) return { health: "off", state: "Not yet ingested", sentence: null };
  const read = cursor ? `newest filing read ${relativeTime(cursor)}` : null;
  if (!status) return { health: "attention", state: "No run recorded", sentence: read };
  const ok = status.startsWith("ok");
  const detail = status.replace(/^\w+:?\s*/, "");
  const m = /(\d[\d,]*) stored \/ (\d[\d,]*) seen/.exec(detail);
  const counts = m
    ? `${m[2]} filing${m[2] === "1" ? "" : "s"} seen on the last run, ${m[1]} stored`
    : ok
      ? detail || null
      : null;
  return {
    health: ok ? "ok" : "attention",
    state: ok ? "Live" : "Attention",
    sentence: [counts, read].filter(Boolean).join(" · ") || null,
  };
}

function cadenceNote(runs: PipelineRun[]): string {
  const gap = medianGapHours(runs);
  if (gap == null) return "";
  return ` Measured over the ${runs.length} runs above: a median ${gap.toFixed(1)} h between runs.`;
}

const METHOD_LABEL: Record<string, string> = {
  text: "PDF text layer (House)",
  vision: "Transcribed from scan (House; quarantined from totals)",
  scanned: "Scanned — unread (House)",
  vision_failed: "Scanned — transcription refused (House; grid not found or readings disagree)",
  efd_html: "eFD report page (Senate)",
  efd_paper: "Paper filing — unread (Senate)",
  error: "Parse error",
};

const SKIP_LABEL: Record<string, string> = {
  no_open_market: "with no open-market rows",
  below_floor: "below the $50k floor",
  no_price: "without a price",
  amendments: "amendments (4/A)",
  not_found: "missing on EDGAR",
  parse_failed: "unreadable",
  other_form: "other forms",
  error: "errors",
};

function parseSkipped(raw: string | null): Record<string, number> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, number>;
    const entries = Object.entries(parsed).filter(([, v]) => v > 0);
    return entries.length ? Object.fromEntries(entries) : null;
  } catch {
    return null;
  }
}
