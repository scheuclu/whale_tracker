import type { InsiderTradeRow } from "@/lib/insider-queries";
import { insiderIssuerHref, price, shares, shortDate, usd } from "@/lib/format";
import { ActionBadge, Amount, InsiderDelayTag, PlanTag, RoleTag, SectorTag, StatusNote, TickerChip } from "./ui";
import { GroupedList, ROW_LINK } from "./grouped-list";

/**
 * Form 4 trades as a grouped list: the insider page's list, and the
 * dashboard's insider trades in followed tickers. `showIssuer` names the
 * company on each row when the list spans several.
 */
export function InsiderTradeList({ trades, showIssuer }: { trades: InsiderTradeRow[]; showIssuer: boolean }) {
  return (
    // One tile, rows under inset hairlines: an iOS grouped list, like the
    // congressional trade lists (trade-row.tsx).
    <GroupedList>
      {trades.map((r) => (
        <li key={r.id} className="px-4 py-3 transition-colors duration-(--dur-fast) hover:bg-[var(--feed-hover)] sm:px-5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <ActionBadge action={r.action} />
            {showIssuer ? (
              <TickerChip ticker={r.ticker} href={r.ticker ? insiderIssuerHref(r.ticker) : undefined} />
            ) : null}
            {r.implausible === 1 ? (
              // Reproduced, not believed: the figure is what was filed, and
              // the label says it counts toward nothing on this page.
              <span className="inline-flex items-center gap-1.5">
                <span className="tabular text-[13px] text-muted-foreground line-through decoration-muted-foreground">
                  {usd(r.amount_exact_cents)}
                </span>
                <StatusNote
                  tone="attention"
                  className="text-[12px] text-ink-2"
                  title="The price cell appears to hold the aggregate consideration (or is otherwise beyond belief). Shown as filed; excluded from every total, cluster value and alert."
                >
                  as filed, implausible
                </StatusNote>
              </span>
            ) : (
              <span className="font-semibold">
                <Amount min={r.amount_min_cents} max={r.amount_max_cents} exact={r.amount_exact_cents} />
              </span>
            )}
            <span className="tabular text-[13px] text-muted-foreground">
              {shares(r.shares)} sh @ {price(r.price_per_share)}
            </span>
            {showIssuer ? (
              <SectorTag group={r.industry_group} sic={r.sic} description={r.sic_description} />
            ) : null}
            <PlanTag value={r.aff_10b5_one} />
            <span className="ml-auto inline-flex items-center gap-2 whitespace-nowrap">
              <span
                className="tabular text-[13px] text-muted-foreground"
                title={r.tx_date_as_filed ? `filed as "${r.tx_date_as_filed}"` : undefined}
              >
                {shortDate(r.tx_date)}
              </span>
              <InsiderDelayTag days={r.delay_days} late={r.late} timeliness={r.timeliness} />
            </span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[14px]">
            {r.insider_cik ? (
              <a href={`/insiders?cik=${encodeURIComponent(r.insider_cik)}`} className={ROW_LINK}>
                {r.insider_name ?? r.insider_cik}
              </a>
            ) : (
              <span className="font-semibold text-muted-foreground">unknown filer</span>
            )}
            <RoleTag
              isDirector={r.is_director}
              isOfficer={r.is_officer}
              isTenPercentOwner={r.is_ten_percent_owner}
              officerTitle={r.officer_title}
              ownerCount={r.owner_count}
            />
            <span className="min-w-0 truncate text-[13px] text-muted-foreground">
              {showIssuer ? r.issuer_name : r.security_title ?? "common stock"}
              {r.direct_or_indirect === "I" && r.nature_of_ownership ? ` · ${r.nature_of_ownership}` : ""}
            </span>
            <a
              href={r.source_url}
              target="_blank"
              rel="noreferrer"
              className="ml-auto rounded-sm text-[12px] text-muted-foreground underline decoration-border-strong underline-offset-[3px] transition-colors duration-(--dur-fast) hover:text-foreground hover:decoration-current"
            >
              filing<span aria-hidden>&nbsp;↗</span>
              <span className="sr-only"> (opens the Form 4 on EDGAR)</span>
            </a>
          </div>
        </li>
      ))}
    </GroupedList>
  );
}

