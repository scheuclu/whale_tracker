import { ChevronRight } from "lucide-react";
import { MoneyText } from "../money";
import type { TickerMemberRow } from "@/lib/queries";
import { memberHref, range, shortDate } from "@/lib/format";
import { seatLabel } from "@/lib/members";
import { SectionTitle } from "../charts";
import { MemberAvatar } from "../avatar";
import { PartyBadge } from "../ui";
import { GroupedList } from "../grouped-list";

/**
 * Who traded this ticker: an iOS grouped list, one row per member — the
 * portrait, name and seat, their buys and sells spelled out, and the range
 * their brackets disclose. Every counted trade is included, not the page's
 * trade list, so the rows add up to the tiles. The whole row is the link.
 */
export function TickerMembers({ ticker, members }: { ticker: string; members: TickerMemberRow[] }) {
  if (!members.length) return null;
  return (
    <section>
      <SectionTitle
        kicker="Congressional Holders"
        right={
          <span>
            {members.length} member{members.length === 1 ? "" : "s"} · by est. volume · disclosed range
          </span>
        }
      >
        Who traded {ticker}
      </SectionTitle>
      <GroupedList inset="4.25rem">
        {members.map((m) => {
          const seat = seatLabel(m.chamber, m.state, m.district);
          const counted = m.trades > m.transcribed;
          const other = m.trades - m.buys - m.sells;
          return (
            <li key={m.member_name}>
              <a
                href={memberHref(m.member_name, m.bioguide_id)}
                className="group/row flex items-center gap-3 px-4 py-2.5 outline-offset-[-2px] transition-colors duration-(--dur-fast) hover:bg-[var(--feed-hover)] sm:px-5"
              >
                <MemberAvatar name={m.member_name} bioguideId={m.bioguide_id} size="lg" />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-[15px] font-semibold tracking-[-0.01em] underline decoration-transparent underline-offset-[3px] transition-[text-decoration-color] group-hover/row:decoration-border-strong">
                      {m.member_name}
                    </span>
                    <PartyBadge party={m.party} />
                  </div>
                  <div className="truncate text-[13px] text-muted-foreground">
                    {seat ?? "not matched to the roster"} · last {shortDate(m.last_tx_date)}
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-0.5 text-right">
                  <span
                    className="tabular text-[14px] text-foreground"
                    title={
                      counted
                        ? "The range this member's brackets disclose for the ticker"
                        : "Transcribed from a scan: counted as a trade, never in a total"
                    }
                  >
                    {counted ? <MoneyText value={range(m.volume_min, m.volume_max)} /> : <span className="text-muted-foreground">not counted</span>}
                  </span>
                  <span className="tabular flex items-center gap-2 text-[12px] text-muted-foreground">
                    {m.buys ? (
                      <span className="inline-flex items-center gap-1">
                        <span aria-hidden className="size-1.5 rounded-full" style={{ background: "var(--viz-buy)" }} />
                        {m.buys} bought
                      </span>
                    ) : null}
                    {m.sells ? (
                      <span className="inline-flex items-center gap-1">
                        <span aria-hidden className="size-1.5 rounded-full" style={{ background: "var(--viz-sell)" }} />
                        {m.sells} sold
                      </span>
                    ) : null}
                    {other > 0 ? <span>{other} exchanged</span> : null}
                  </span>
                </div>
                <ChevronRight aria-hidden className="hidden size-4 shrink-0 text-ink-3 sm:block" strokeWidth={2.25} />
              </a>
            </li>
          );
        })}
      </GroupedList>
    </section>
  );
}
