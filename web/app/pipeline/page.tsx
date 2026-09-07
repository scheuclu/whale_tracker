import { getPipeline } from "@/lib/queries";
import { relativeTime } from "@/lib/format";
import { Card, Empty, SectionTitle, StatTile } from "../charts";
import { StatusBadge } from "../ui";

export const dynamic = "force-dynamic";

export default async function PipelinePage() {
  let p;
  try {
    p = await getPipeline();
  } catch (err) {
    return <Empty>{(err as Error).message}</Empty>;
  }

  const senateOk = p.senateStatus?.startsWith("ok");
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
                    "included below; the figures on this site are House-only."}
              </p>
              {!senateOk && p.senateStatus ? (
                <p className="mt-1 font-mono text-[11px] text-muted-foreground">{p.senateStatus}</p>
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
