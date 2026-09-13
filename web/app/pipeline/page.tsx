import { getPipeline } from "@/lib/queries";
import { getInsiderPipeline } from "@/lib/insider-queries";
import { relativeTime } from "@/lib/format";
import { Card, Empty, SectionTitle, StatTile } from "../charts";
import { StatusBadge } from "../ui";

export const dynamic = "force-dynamic";

export default async function PipelinePage() {
  let p, ins;
  try {
    [p, ins] = await Promise.all([getPipeline(), getInsiderPipeline()]);
  } catch (err) {
    return <Empty>{(err as Error).message}</Empty>;
  }

  const senateOk = p.senateStatus?.startsWith("ok");
  const edgarStatus = ins?.state.edgar_status ?? null;
  const edgarOk = edgarStatus?.startsWith("ok") ?? false;
  const skipped = parseSkipped(ins?.state.edgar_skipped ?? null);
  const readable = p.coverage.parsed + p.coverage.unreadable;
  const readablePct = readable ? Math.round((p.coverage.parsed / readable) * 100) : 0;

  return (
    <div className="space-y-8">
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Filings indexed" value={p.totals.filings.toLocaleString()} />
        <StatTile label="Trades parsed" value={p.totals.transactions.toLocaleString()} />
        <StatTile label="Readable" value={`${readablePct}%`} hint={`${p.coverage.unreadable} scans unread`} />
        <StatTile label="Last run" value={relativeTime(p.lastUpdated)} />
      </section>

      <section>
        <SectionTitle>Coverage</SectionTitle>
        <Card className="space-y-4">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 size-2 shrink-0 rounded-full bg-emerald-500" />
            <div>
              <div className="text-[13px] font-medium">US House — full coverage</div>
              <p className="text-xs text-muted-foreground">
                Periodic transaction reports from the Clerk&rsquo;s bulk disclosure
                index, parsed directly from the filed PDFs.
              </p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <span
              className={`mt-0.5 size-2 shrink-0 rounded-full ${senateOk ? "bg-emerald-500" : "bg-amber-500"}`}
            />
            <div>
              <div className="text-[13px] font-medium">
                US Senate — {senateOk ? "available" : "unavailable"}
              </div>
              <p className="text-xs text-muted-foreground">
                {senateOk
                  ? p.senateStatus
                  : "The Senate eFD search sits behind bot protection that refuses " +
                    "automated access from datacenter addresses. No Senate trades are " +
                    "included; the congressional figures on this site are House-only."}
              </p>
              {!senateOk && p.senateStatus ? (
                <p className="mt-1 font-mono text-[11px] text-muted-foreground">{p.senateStatus}</p>
              ) : null}
            </div>
          </div>
          <div className="flex items-start gap-3">
            <span
              className={`mt-0.5 size-2 shrink-0 rounded-full ${
                edgarOk ? "bg-emerald-500" : ins ? "bg-amber-500" : "bg-zinc-400"
              }`}
            />
            <div className="min-w-0">
              <div className="text-[13px] font-medium">
                SEC Form 4 insiders — {edgarOk ? "live" : ins ? "attention" : "not yet ingested"}
              </div>
              <p className="text-xs text-muted-foreground">
                Corporate officers, directors and 10% owners, from EDGAR&rsquo;s live feed.
                Only filings with open-market buys or sells of $50k+ in one direction are
                stored; grants, option exercises, tax withholding and gifts are not.
                Amendments (4/A) and the derivative table are not ingested yet.
              </p>
              {ins ? (
                <>
                  <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                    {edgarStatus ?? "no run recorded"}
                    {ins.state.edgar_cursor ? ` · cursor ${relativeTime(ins.state.edgar_cursor)}` : ""}
                  </p>
                  {skipped ? (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Last run skipped:{" "}
                      {Object.entries(skipped)
                        .map(([k, v]) => `${v} ${SKIP_LABEL[k] ?? k}`)
                        .join(" · ")}
                    </p>
                  ) : null}
                  {ins.state.edgar_gap ? (
                    <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
                      Feed gap {ins.state.edgar_gap} — repair with{" "}
                      <code className="font-mono">
                        backfill-insiders --from {ins.state.edgar_gap.split("..")[0]} --to{" "}
                        {ins.state.edgar_gap.split("..")[1]}
                      </code>
                    </p>
                  ) : null}
                  {ins.state.edgar_backfill_through ? (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Daily-index history loaded through {ins.state.edgar_backfill_through}.
                    </p>
                  ) : null}
                </>
              ) : null}
            </div>
          </div>
        </Card>
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
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
              <p className="pt-1 text-[11px] text-muted-foreground">
                Form 4 filings enter as history until insider alerts exist; {ins.totals.trades.toLocaleString()}{" "}
                open-market trades across {ins.totals.issuers.toLocaleString()} issuers are stored.
              </p>
            ) : null}
          </Card>
        </div>

        <div>
          <SectionTitle>How filings were read</SectionTitle>
          <Card className="space-y-2">
            {p.byMethod.map((m) => (
              <div key={m.parse_method} className="flex items-center gap-3 text-[13px]">
                <span className="font-medium">
                  {m.parse_method === "text"
                    ? "PDF text layer"
                    : m.parse_method === "vision"
                      ? "Vision model (scanned)"
                      : m.parse_method === "scanned"
                        ? "Scanned — unread"
                        : m.parse_method}
                </span>
                <div className="flex-1" />
                <span className="tabular text-muted-foreground">{m.n.toLocaleString()}</span>
              </div>
            ))}
            <p className="pt-1 text-[11px] text-muted-foreground">
              Members may file on paper. Those filings arrive as image-only scans with
              no text layer; without a vision model configured they are reported to
              Telegram with a link but contribute no transactions to the totals.
            </p>
          </Card>
        </div>
      </section>

      {ins?.failures.length ? (
        <section>
          <SectionTitle>Unreadable Form 4s</SectionTitle>
          <Card className="space-y-1.5">
            {ins.failures.map((f) => (
              <div key={f.accession} className="flex flex-wrap items-center gap-x-3 text-[13px]">
                <a
                  href={f.source_url}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-xs hover:text-primary"
                >
                  {f.accession}
                </a>
                <span className="font-medium">{f.issuer_name ?? "unknown issuer"}</span>
                <span className="truncate text-xs text-muted-foreground">{f.last_error}</span>
              </div>
            ))}
          </Card>
        </section>
      ) : null}

      {p.failures.length ? (
        <section>
          <SectionTitle>Unreadable filings</SectionTitle>
          <Card className="space-y-1.5">
            {p.failures.map((f) => (
              <div key={f.doc_id} className="flex flex-wrap items-center gap-x-3 text-[13px]">
                <a
                  href={f.pdf_url}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-xs hover:text-primary"
                >
                  {f.doc_id}
                </a>
                <span className="font-medium">{f.filer_name}</span>
                <span className="truncate text-xs text-muted-foreground">{f.last_error}</span>
              </div>
            ))}
          </Card>
        </section>
      ) : null}
    </div>
  );
}

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
