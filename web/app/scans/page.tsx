import { getScanFilings, getScanTotals } from "@/lib/scan-queries";
import { memberHref, shortDate } from "@/lib/format";
import { Card, Empty, SectionTitle, StatTile } from "../charts";
import { PartyBadge, StatusBadge, ResponsiveTable } from "../ui";
import { pageMetadata } from "@/lib/seo";

export const dynamic = "force-dynamic";

// The index of scans is indexable (it says what exists and why it is not
// counted); a per-member filter is a view of it. The per-filing pages are
// `noindex` — see app/scans/[docId]/page.tsx.
export const metadata = pageMetadata({
  title: "Scanned paper filings",
  description:
    "House STOCK Act filings submitted as scanned paper, what the grid reader made of each page, and why transcribed rows are shown but never counted in any total.",
  path: "/scans",
});

/**
 * Scanned paper filings and what the grid reader made of them. Every House
 * scan is listed whether or not it has been captured; a captured one links
 * to its pages with the reader's decisions drawn over them. Nothing on this
 * page is a statistic — it is the audit trail for the transcription path.
 */
export default async function ScansPage({
  searchParams,
}: {
  searchParams: Promise<{ m?: string }>;
}) {
  const params = await searchParams;
  let filings, totals;
  try {
    [filings, totals] = await Promise.all([getScanFilings({ member: params.m }), getScanTotals()]);
  } catch (err) {
    return <Empty>{(err as Error).message}</Empty>;
  }

  return (
    <div className="space-y-8">
      {/* Reached from the footer; the heading names it for screen readers and crawlers. */}
      <h1 className="sr-only">Scanned paper filings</h1>
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile
          label="Scanned filings"
          value={String(totals.filings)}
          hint={`${totals.captured} captured for inspection`}
        />
        <StatTile
          label="Pages captured"
          value={String(totals.pages)}
          hint={`${(totals.png_bytes / 1e6).toFixed(2)} MB of images`}
        />
        <StatTile label="Rows read" value={String(totals.rows)} hint="by the grid reader" />
        <StatTile
          label="Unknown rows"
          value={String(totals.unknown_rows)}
          hint="amount or type left unknown, not guessed"
        />
      </section>

      <section>
        <SectionTitle
          right={
            params.m ? (
              <a href="/scans" className="text-[11px] text-muted-foreground hover:text-primary">
                all members
              </a>
            ) : (
              <span className="text-[11px] text-muted-foreground">newest filing first</span>
            )
          }
        >
          {params.m ? `Scanned filings — ${params.m}` : "Scanned filings"}
        </SectionTitle>
        {filings.length ? (
          <ResponsiveTable wrap>
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-[0.06em] text-muted-foreground">
                  <th className="px-4 py-2.5 font-medium">Filing</th>
                  <th className="px-4 py-2.5 font-medium">Member</th>
                  <th className="px-4 py-2.5 font-medium">Filed</th>
                  <th className="px-4 py-2.5 font-medium">State</th>
                  <th className="px-4 py-2.5 text-right font-medium">Pages</th>
                  <th className="px-4 py-2.5 text-right font-medium">Rows read</th>
                  <th className="px-4 py-2.5 text-right font-medium">Unknown</th>
                  <th className="px-4 py-2.5 text-right font-medium">Transactions</th>
                  <th className="px-4 py-2.5 font-medium">PDF</th>
                </tr>
              </thead>
              <tbody>
                {filings.map((f) => (
                  <tr key={f.id} className="border-b border-border/50 last:border-0 hover:bg-muted/50">
                    <td className="px-4 py-2 font-mono text-xs">
                      {f.pages ? (
                        <a href={`/scans/${encodeURIComponent(f.doc_id)}`} className="font-semibold hover:text-primary">
                          {f.doc_id}
                        </a>
                      ) : (
                        <span title="Not captured yet — run `python -m whale capture-scans`">{f.doc_id}</span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2">
                        <PartyBadge party={f.party} />
                        <a href={memberHref(f.member_name, f.bioguide_id)} className="whitespace-nowrap font-medium hover:text-primary">
                          {f.member_name}
                        </a>
                      </div>
                    </td>
                    <td className="tabular px-4 py-2 text-muted-foreground">{shortDate(f.filing_date)}</td>
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2">
                        <StatusBadge
                          value={
                            f.status === "failed" && f.parse_method === "scanned" && f.rows > 0
                              ? "not_transcribed"
                              : f.status
                          }
                        />
                        <span className="text-[11px] text-muted-foreground">
                          {METHOD_LABEL[f.parse_method ?? ""] ?? f.parse_method}
                        </span>
                      </div>
                    </td>
                    <td className="tabular px-4 py-2 text-right">
                      {f.pages ? (
                        <>
                          {f.pages}
                          {f.pages_failed ? (
                            <span className="text-[11px] text-amber-600 dark:text-amber-400">
                              {" "}· {f.pages_failed} unread
                            </span>
                          ) : null}
                        </>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="tabular px-4 py-2 text-right">{f.pages ? f.rows : "—"}</td>
                    <td
                      className={`tabular px-4 py-2 text-right ${
                        f.unknown_rows ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"
                      }`}
                    >
                      {f.pages ? f.unknown_rows : "—"}
                    </td>
                    <td className="tabular px-4 py-2 text-right text-muted-foreground">{f.transactions}</td>
                    <td className="px-4 py-2">
                      <a
                        href={f.pdf_url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[11px] text-muted-foreground underline-offset-2 hover:text-primary hover:underline"
                      >
                        Clerk
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ResponsiveTable>
        ) : (
          <Empty>No scanned filings{params.m ? ` for ${params.m}` : ""}.</Empty>
        )}
        <p className="mt-3 text-[11px] text-muted-foreground">
          A scanned filing has no text layer. The grid reader finds the printed rules and
          reads the ticked amount and type boxes; a vision model, when enabled, transcribes the
          written text. &ldquo;Rows read&rdquo; is what the reader found; an unknown row is a box
          it would not call. Transactions exist only for filings the transcription path has
          read, and those are quarantined from every total. Capture with{" "}
          <code className="font-mono">python -m whale capture-scans</code>.
        </p>
      </section>
    </div>
  );
}

const METHOD_LABEL: Record<string, string> = {
  scanned: "scan — not transcribed",
  vision: "transcribed (quarantined)",
  // A captured scan whose later transcription attempt crashed rather than
  // being refused; it stays listed because its capture is the record.
  error: "transcription errored",
  vision_failed: "transcription refused",
};
