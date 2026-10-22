import { cn } from "@/lib/utils";
import { Segmented } from "./ui";
import { Empty } from "./charts";

/**
 * Page composition shared by every route: one hero, then sections at one
 * rhythm (40px apart on desktop, 28px on a phone). Kept apart from the
 * section and card components so each route reads the same top to bottom.
 */

/**
 * A page's wrapper. The rhythm itself (28px phone / 40px from `sm`) is set
 * once by `.page-flow` on `<main>`, which targets this class; pages add no
 * section margins of their own.
 */
export const PAGE_STACK = "space-y-8";

/**
 * A page's hero: an optional back link, an eyebrow, the title, one line of
 * subtitle, and a slot for the key facts (usually a row of stat tiles).
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
  children,
}: {
  back?: { href: string; label: string };
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
    <header className="space-y-5">
      <div className="space-y-2">
        {back || share ? (
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
            {back ? <BackLink href={back.href} label={back.label} /> : <span />}
            {share}
          </div>
        ) : null}
        <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-4">
          <div className="min-w-0 max-w-full">
            {eyebrow ? (
              <div className="mb-1 text-[12px] font-medium text-muted-foreground">{eyebrow}</div>
            ) : null}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <h1
                className={cn(
                  "min-w-0 break-words text-[28px] font-semibold leading-tight tracking-tight sm:text-[36px]",
                  titleClassName
                )}
              >
                {title}
              </h1>
              {badges}
            </div>
            {subtitle ? (
              <p className="mt-1.5 max-w-[68ch] text-[14px] leading-relaxed text-muted-foreground sm:text-[15px]">
                {subtitle}
              </p>
            ) : null}
          </div>
          {aside ? <div className="w-full min-w-0 sm:w-auto">{aside}</div> : null}
        </div>
      </div>
      {children}
    </header>
  );
}

/** "← all members": the way back to a detail page's list. */
export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      className="inline-flex rounded-md text-xs text-muted-foreground transition-colors duration-150 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      ← {label}
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
  const message = error instanceof Error ? error.message : String(error);
  return <Empty>{context ? `${context}: ${message}` : message}</Empty>;
}

/** An empty section or a zero state: one muted line, not a box the size of a chart. */
export function Quiet({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={cn("max-w-[68ch] text-[13px] text-muted-foreground", className)}>{children}</p>;
}

export type Health = "ok" | "attention" | "error" | "off";

/** Status tokens from globals.css — never the buy/sell pair. */
const HEALTH_TONE: Record<Health, { cls: string; dot: string }> = {
  ok: { cls: "text-ok bg-ok-soft border-ok/25", dot: "bg-ok" },
  attention: { cls: "text-attention bg-attention-soft border-attention/25", dot: "bg-attention" },
  error: { cls: "text-error bg-error-soft border-error/25", dot: "bg-error" },
  off: { cls: "text-muted-foreground bg-muted border-border", dot: "bg-muted-foreground" },
};

/** A source's or run's state as a pill: the word carries it, the dot repeats it. */
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
      <span aria-hidden className={cn("size-1.5 rounded-full", t.dot)} />
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
