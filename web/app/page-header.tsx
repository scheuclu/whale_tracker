import { ChevronLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { STATUS_MARK, Segmented } from "./ui";
import { Empty } from "./charts";
import { publicErrorMessage } from "@/lib/public-error";

/**
 * Page composition shared by every route: one large title, then sections
 * at one rhythm (48px apart on desktop, 32px on a phone). Kept apart from
 * the section and card components so each route reads the same top to
 * bottom.
 */

/**
 * A page's wrapper. The rhythm itself (32px phone / 48px from `sm`) is set
 * once by `.page-flow` on `<main>`, which targets this class; pages add no
 * section margins of their own.
 */
export const PAGE_STACK = "space-y-8";

/**
 * A page's head, iOS "large title" style: an optional grey eyebrow → the
 * title (display face, bold, 34px on a phone, 48px from 640px, tight) →
 * the subtitle (one sentence, 17–19px, secondary grey) → the key facts
 * (usually a row of StatTiles). An optional back link and share control
 * sit above.
 * `aside` sits to the right of the title on a wide screen and under it on a
 * phone — a split bar, a window picker.
 */
export function PageHeader({
  back,
  eyebrow,
  title,
  titleClassName,
  badges,
  subtitle,
  aside,
  share,
  lead,
  children,
}: {
  back?: { href: string; label: string };
  /** In place of the back link, on the share row: a hub's view switcher (/rankings). */
  lead?: React.ReactNode;
  /** The page's `ShareControl` (app/share-control.tsx), on the back link's row, right-aligned. */
  share?: React.ReactNode;
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  /** Merged onto the h1 — a ticker or filing id sets it in mono. */
  titleClassName?: string;
  /** Chips set on the title's baseline: asset type, sector, party. */
  badges?: React.ReactNode;
  subtitle?: React.ReactNode;
  aside?: React.ReactNode;
  /** Key facts and any intro under the title. */
  children?: React.ReactNode;
}) {
  return (
    <header className="space-y-6 sm:space-y-8">
      <div className="apple-headline-reveal space-y-3.5">
        {back || share || lead ? (
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            {lead ?? (back ? <BackLink href={back.href} label={back.label} /> : <span />)}
            {share}
          </div>
        ) : null}
        <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-4">
          <div className="min-w-0 max-w-full">
            {eyebrow ? (
              <div className="mb-2 inline-flex items-center gap-2 rounded-full bg-fill/75 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground ring-1 ring-black/[0.04] dark:ring-white/[0.08]">
                {eyebrow}
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2">
              <h1
                className={cn(
                  "display min-w-0 break-words text-balance text-[36px] leading-[1.06] tracking-[-0.032em] text-foreground sm:text-[52px] sm:leading-[1.03]",
                  titleClassName
                )}
              >
                {title}
              </h1>
              {badges}
            </div>
            {subtitle ? (
              <p className="dek mt-2.5 max-w-[64ch] text-[17px] leading-[1.46] sm:mt-3.5 sm:text-[19px] sm:leading-[1.44]">{subtitle}</p>
            ) : null}
          </div>
          {aside ? <div className="w-full min-w-0 sm:w-auto">{aside}</div> : null}
        </div>
      </div>
      {children}
    </header>
  );
}

/** "‹ All members": the way back to a detail page's list, iOS-style capsule button. */
export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      className="inline-flex items-center gap-1 rounded-full bg-fill/85 py-1 pl-2 pr-3 text-[13px] font-medium text-ink-2 ring-1 ring-black/[0.04] transition-all duration-(--dur) hover:bg-foreground/[0.09] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background dark:ring-white/[0.08]"
    >
      <ChevronLeft className="size-4" strokeWidth={2.4} aria-hidden />
      <span className="first-letter:uppercase">{label}</span>
    </a>
  );
}

/**
 * Every page's and section's "the query failed" state, in one place. A page
 * catch block renders `<DataError error={err} />`; `context` prefixes a
 * section-level failure ("Insider data unavailable"). To adopt the states
 * lane's `DataUnavailable` (status-screen.tsx, #94), change only the body
 * of this function.
 */
export function DataError({ error, context }: { error: unknown; context?: string }) {
  const message = publicErrorMessage(error);
  return <Empty>{context ? `${context}: ${message}` : message}</Empty>;
}

/** An empty section or a zero state: one muted line, not a box the size of a chart. */
export function Quiet({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={cn("max-w-[68ch] text-[14px] text-muted-foreground", className)}>{children}</p>;
}

export type Health = "ok" | "attention" | "error" | "off";

/**
 * iOS Settings style: a grey pill, the word in ink, and the status as a
 * small accent — a green dot, a grey triangle, a red diamond (with a
 * hairline round the pill) for an error. The pill is never tinted.
 */
const HEALTH_TONE: Record<Health, { cls: string; dot: string }> = {
  ok: { cls: "text-ink-2 bg-fill border-transparent", dot: STATUS_MARK.ok },
  attention: { cls: "text-ink-2 bg-fill border-transparent", dot: STATUS_MARK.attention },
  error: { cls: "text-foreground bg-fill border-border-strong", dot: STATUS_MARK.error },
  off: { cls: "text-muted-foreground bg-fill border-transparent", dot: "bg-muted-foreground rounded-full" },
};

/** A source's or run's state as a pill: the word carries it, the mark repeats it. */
export function HealthPill({ health, children, title }: { health: Health; children: React.ReactNode; title?: string }) {
  const t = HEALTH_TONE[health];
  return (
    <span
      title={title}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[12px] font-medium",
        t.cls
      )}
    >
      <span aria-hidden className={cn("size-1.5", t.dot)} />
      {children}
    </span>
  );
}

/** Window or filter pills, the same everywhere: a row of links, one current. */
export function PillLinks({
  items,
  label,
  note,
  className,
}: {
  items: { href: string; label: React.ReactNode; active: boolean }[];
  /** Accessible name of the group, e.g. "Window". */
  label: string;
  /** Muted words after the pills: what the window is measured on. */
  note?: React.ReactNode;
  className?: string;
}) {
  // The control itself is the shared `Segmented` (app/ui.tsx); this only
  // adds the note and lets a long group scroll rather than overflow a phone.
  return (
    <div className={cn("flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 text-xs", className)}>
      <div className="scrollbar-none -m-1 max-w-[calc(100%+0.5rem)] overflow-x-auto p-1">
        <Segmented
          label={label}
          items={items.map((it, i) => ({ key: String(i), label: it.label, href: it.href, active: it.active }))}
        />
      </div>
      {note ? <span className="text-muted-foreground">{note}</span> : null}
    </div>
  );
}
