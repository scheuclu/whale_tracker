import { getPoliticians } from "@/lib/queries";
import { memberHref, range, usd } from "@/lib/format";
import { Card, SectionTitle, VOLUME_NOTE } from "../charts";
import { DataError, PAGE_STACK, PageHeader, Quiet } from "../page-header";
import { MemberBars } from "../politicians/member-bars";

/** `/rankings?view=active`: the members who trade the most, two ways. */
export const ACTIVE_PATH = "/rankings?view=active";

const SHOWN = 15;

export async function ActiveView({ nav }: { nav?: React.ReactNode } = {}) {
  let rows;
  try {
    rows = await getPoliticians(undefined, 2000);
  } catch (err) {
    return <DataError error={err} />;
  }
  const byTrades = [...rows].sort((a, b) => b.trades - a.trades);
  return (
    <div className={PAGE_STACK}>
      <PageHeader
        lead={nav}
        eyebrow="Congress · activity"
        title="Most active"
        subtitle="The members of Congress with the most disclosed trading, by estimated volume and by number of trades. Amounts are disclosed brackets, so every volume here is an estimate."
      />
      {rows.length ? (
        <section className="grid gap-6 lg:grid-cols-2">
          <div>
            <SectionTitle kicker="Volume ranking">By estimated volume</SectionTitle>
            <Card>
              <MemberBars
                data={rows.slice(0, SHOWN).map((r) => ({
                  key: r.member_name,
                  name: r.member_name,
                  bioguideId: r.bioguide_id,
                  sublabel: `${r.party ?? "?"}-${r.state ?? "?"} · ${r.trades} trade${r.trades === 1 ? "" : "s"}`,
                  value: r.volume_mid,
                  valueLabel: usd(r.volume_mid),
                  detail: r.volume_min != null ? `disclosed ${range(r.volume_min, r.volume_max ?? null)}` : undefined,
                  href: memberHref(r.member_name, r.bioguide_id),
                }))}
                note={VOLUME_NOTE}
              />
            </Card>
          </div>
          <div>
            <SectionTitle kicker="Activity ranking">By number of trades</SectionTitle>
            <Card>
              <MemberBars
                data={byTrades.slice(0, SHOWN).map((r) => ({
                  key: r.member_name,
                  name: r.member_name,
                  bioguideId: r.bioguide_id,
                  // A scan-only member has trades but no symbol: paper forms do not print one.
                  sublabel:
                    r.tickers === 0 && r.transcribed > 0
                      ? "tickers not printed on paper filings"
                      : `${r.tickers} distinct ticker${r.tickers === 1 ? "" : "s"}`,
                  value: r.trades,
                  valueLabel: String(r.trades),
                  href: memberHref(r.member_name, r.bioguide_id),
                }))}
              />
            </Card>
          </div>
        </section>
      ) : (
        <Quiet>No trades yet.</Quiet>
      )}
    </div>
  );
}
