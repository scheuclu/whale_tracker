import { cn } from "@/lib/utils";
import { Empty } from "../charts";
import { MemberAvatar } from "../avatar";

export type MemberBarDatum = {
  key: string;
  name: string;
  bioguideId?: string | null;
  sublabel?: string;
  value: number;
  valueLabel: string;
  href?: string;
};

/**
 * A ranked member leaderboard: `MagnitudeBars` with a face. Same mark spec —
 * one sequential hue (this is one measure, not a series per member), a 12px
 * bar with a 4px rounded data end, the value at the tip — so the member
 * boards read as the same chart family as the ticker boards beside them.
 * The rank is printed because the order is the point of the list.
 */
export function MemberBars({ data }: { data: MemberBarDatum[] }) {
  if (!data.length) return <Empty />;
  const max = Math.max(...data.map((d) => d.value), 1);

  return (
    <ol className="space-y-1">
      {data.map((d, i) => {
        const pct = Math.max((d.value / max) * 100, 0.8);
        const row = (
          <div className="grid grid-cols-[10.5rem_1fr_auto] items-center gap-3 sm:grid-cols-[14rem_1fr_auto]">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="tabular hidden w-4 shrink-0 text-right text-[11px] text-muted-foreground/70 sm:block">
                {i + 1}
              </span>
              <MemberAvatar name={d.name} bioguideId={d.bioguideId} size="md" />
              <div className="min-w-0">
                <div title={d.name} className="truncate text-[13px] font-semibold tracking-tight">
                  {d.name}
                </div>
                {d.sublabel ? (
                  <div className="truncate text-[11px] text-muted-foreground">{d.sublabel}</div>
                ) : null}
              </div>
            </div>
            <div
              className="h-3 rounded-sm"
              style={{ background: "var(--viz-track)" }}
              role="img"
              aria-label={`${d.name}: ${d.valueLabel}`}
            >
              <div
                className="h-3"
                style={{ width: `${pct}%`, background: "var(--viz-seq)", borderRadius: "2px 4px 4px 2px" }}
              />
            </div>
            <div className="tabular w-14 text-right text-[13px] text-muted-foreground sm:w-20">
              {d.valueLabel}
            </div>
          </div>
        );
        return (
          <li key={d.key}>
            {d.href ? (
              <a
                href={d.href}
                className={cn(
                  "group block rounded-xl px-1.5 py-1 transition-colors hover:bg-muted",
                  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
                )}
              >
                {row}
              </a>
            ) : (
              <div className="px-1.5 py-1">{row}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
