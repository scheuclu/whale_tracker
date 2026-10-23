import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { BrandMark } from "./brand";

/**
 * The shared body of not-found.tsx, error.tsx and the "database
 * unavailable" state: the mark, a status chip, what happened in one
 * sentence, one clear action, the technical detail folded away, and a way
 * back into the main sections. No hooks, so it renders from the server 404
 * and the client error boundary alike.
 */
const SECTIONS = [
  { href: "/", label: "Feed", hint: "Latest disclosed trades" },
  { href: "/politicians", label: "Members", hint: "Who is trading" },
  { href: "/tickers", label: "Tickers", hint: "What is being traded" },
  { href: "/insiders", label: "Insiders", hint: "Form 4 open-market trades" },
];

/** Status colours describe system state only — never buy/sell. */
const TONE = {
  neutral: { chip: "bg-muted text-ink-2", dot: "bg-muted-foreground" },
  attention: { chip: "bg-attention-soft text-attention", dot: "bg-attention" },
  error: { chip: "bg-error-soft text-error ring-1 ring-inset ring-error/40", dot: "bg-error rounded-[1px]! rotate-45" },
} as const;

export function StatusScreen({
  code,
  title,
  tone = "neutral",
  children,
  action,
  secondary,
  details,
}: {
  /** The chip above the title: "404 · Not found", "Error", … */
  code: string;
  title: string;
  tone?: keyof typeof TONE;
  /** One or two sentences: what happened, what to do. */
  children: React.ReactNode;
  /** The one primary action. */
  action?: React.ReactNode;
  /** A quieter alternative, rendered as a text link beside it. */
  secondary?: React.ReactNode;
  /** Technical detail (a message, an error reference), behind a disclosure. */
  details?: React.ReactNode;
}) {
  const t = TONE[tone];
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center pb-4 pt-6 text-center sm:pt-12">
      <div className="status-mark">
        <BrandMark className="size-14" />
      </div>
      <p
        className={cn(
          "mt-6 inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium",
          t.chip
        )}
      >
        <span aria-hidden className={cn("size-1.5 rounded-full", t.dot)} />
        {code}
      </p>
      <h1 className="display mt-3 text-balance text-[34px] leading-[1.08] sm:text-[44px]">
        {title}
      </h1>
      <div className="dek mt-3 max-w-[56ch] text-pretty text-[17px] leading-normal">{children}</div>
      {action || secondary ? (
        <div className="mt-6 flex flex-wrap items-center justify-center gap-x-5 gap-y-3">
          {action}
          {secondary}
        </div>
      ) : null}
      {details ? (
        <details className="status-details group mt-6 w-full max-w-md text-left">
          <summary className="mx-auto flex w-fit cursor-pointer list-none items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
            <ChevronRight aria-hidden className="size-3.5 transition-transform group-open:rotate-90" />
            Technical details
          </summary>
          <div className="tile mt-2 overflow-x-auto rounded-control px-3.5 py-3 font-mono text-xs leading-relaxed text-ink-2">
            {details}
          </div>
        </details>
      ) : null}

      <nav aria-label="Main sections" className="mt-12 w-full text-left">
        <p className="kicker mb-2 pl-1">Or go to</p>
        {/* An iOS grouped list: one tile, inset separators, a chevron per row. */}
        <ul className="tile inset-rows overflow-hidden py-1 [--sep-inset:1.25rem]">
          {SECTIONS.map(({ href, label, hint }) => (
            <li key={href}>
              <Link
                href={href}
                className="group flex min-h-11 items-center gap-3 px-5 py-3 outline-offset-[-2px] transition-colors hover:bg-[var(--feed-hover)]"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-[16px] font-semibold tracking-[-0.012em]">{label}</span>
                  <span className="block truncate text-[13px] text-muted-foreground">{hint}</span>
                </span>
                <ChevronRight
                  className="size-4 shrink-0 text-ink-3 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none motion-reduce:group-hover:translate-x-0"
                  strokeWidth={2.25}
                  aria-hidden
                />
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}

/**
 * The trade database could not be opened: not configured, the file is
 * missing, or the fetch failed. Pages that catch a failed read can render
 * this in place of the error string, so a reader sees one calm screen
 * rather than a bare message in every section.
 */
export function DataUnavailable({ message, action }: { message: string; action?: React.ReactNode }) {
  const notConfigured = /not configured|no database|TRADES_DB_REPO is set/i.test(message);
  return (
    <StatusScreen
      code={notConfigured ? "Not configured" : "Data unavailable"}
      tone="attention"
      title={notConfigured ? "No trade database is connected" : "The trade database didn't load"}
      action={action}
      secondary={
        <Link href="/pipeline" className={secondaryAction}>
          Pipeline status
        </Link>
      }
      details={message}
    >
      {notConfigured
        ? "The dashboard reads the database the pipeline commits. This deployment has not been pointed at it yet — the details below say which setting is missing."
        : "The dashboard fetches the pipeline's database on each visit, and this fetch failed. It is usually passing: try again in a moment."}
    </StatusScreen>
  );
}

/** The one primary action: a graphite capsule (white in dark mode), like `BUTTON_PRIMARY`. */
export const primaryAction =
  "inline-flex h-10 items-center gap-1.5 rounded-full bg-primary px-5 text-[15px] font-semibold text-primary-foreground transition-opacity duration-[var(--dur-fast)] ease-out hover:opacity-85 active:opacity-75";
/** The quieter alternative: a text link. */
export const secondaryAction =
  "inline-flex h-10 items-center gap-1.5 rounded-full bg-fill px-5 text-[15px] font-medium text-foreground transition-colors duration-[var(--dur-fast)] hover:bg-foreground/[0.1]";
