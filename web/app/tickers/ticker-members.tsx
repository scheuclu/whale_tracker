import type { TickerMemberRow } from "@/lib/queries";
import { memberHref, range, shortDate } from "@/lib/format";
import { seatLabel } from "@/lib/members";
import { SectionTitle } from "../charts";
import { MemberAvatar } from "../avatar";
import { PartyBadge } from "../ui";

/**
 * Who traded this ticker: one card per member, with their buys and sells
 * spelled out and the range their brackets disclose. Every counted trade is
 * included, not the page's trade list, so the cards add up to the tiles.
 */
export function TickerMembers({ ticker, members }: { ticker: string; members: TickerMemberRow[] }) {
  if (!members.length) return null;
  return (
    <section>
      <SectionTitle
        right={
          <span className="text-[11px] text-muted-foreground">
            {members.length} member{members.length === 1 ? "" : "s"} · by est. volume · disclosed range
          </span>
        }
      >
        Who traded {ticker}
      </SectionTitle>
      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {members.map((m) => {
          const seat = seatLabel(m.chamber, m.state, m.district);
          const counted = m.trades > m.transcribed;
          return (
            <li key={m.member_name}>
              <a
                href={memberHref(m.member_name, m.bioguide_id)}
                className="glass lift flex h-full items-center gap-3 rounded-2xl border border-border bg-card px-3.5 py-3"
              >
                <MemberAvatar name={m.member_name} bioguideId={m.bioguide_id} size="lg" />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-[13px] font-semibold tracking-tight">{m.member_name}</span>
                    <PartyBadge party={m.party} />
                  </div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {seat ?? "not matched to the roster"} · last {shortDate(m.last_tx_date)}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2.5 text-[11px]">
                    {m.buys ? (
                      <span className="inline-flex items-center gap-1">
                        <span className="size-1.5 rounded-full" style={{ background: "var(--viz-buy)" }} />
                        <span className="tabular font-medium">{m.buys}</span>
                        <span className="text-muted-foreground">bought</span>
                      </span>
                    ) : null}
                    {m.sells ? (
                      <span className="inline-flex items-center gap-1">
                        <span className="size-1.5 rounded-full" style={{ background: "var(--viz-sell)" }} />
                        <span className="tabular font-medium">{m.sells}</span>
                        <span className="text-muted-foreground">sold</span>
                      </span>
                    ) : null}
                    {m.trades - m.buys - m.sells > 0 ? (
                      <span className="text-muted-foreground">
                        {m.trades - m.buys - m.sells} exchanged
                      </span>
                    ) : null}
                  </div>
                </div>
                <div
                  className="tabular shrink-0 self-start text-right text-[12px] text-muted-foreground"
                  title={
                    counted
                      ? "The range this member's brackets disclose for the ticker"
                      : "Transcribed from a scan: counted as a trade, never in a total"
                  }
                >
                  {counted ? range(m.volume_min, m.volume_max) : "not counted"}
                </div>
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
