import Link from "next/link";
import { ArrowRight, Briefcase, ChevronRight, Landmark, LineChart, Receipt } from "lucide-react";
import { cn } from "@/lib/utils";
import { WhaleMark } from "./brand";

/**
 * The shared body of not-found.tsx, error.tsx and the "database
 * unavailable" state: the mark, a status chip, what happened in one
 * sentence, one clear action, the technical detail folded away, and a way
 * back into the main sections. No hooks, so it renders from the server 404
 * and the client error boundary alike.
 */
const SECTIONS = [
  { href: "/", label: "Feed", icon: Receipt, hint: "Latest disclosed trades" },
  { href: "/tickers", label: "Tickers", icon: LineChart, hint: "What is being traded" },
  { href: "/politicians", label: "Politicians", icon: Landmark, hint: "Who is trading" },
  { href: "/insiders", label: "Insiders", icon: Briefcase, hint: "Form 4 open-market trades" },
];

/** Status colours describe system state only — never buy/sell. */
const TONE = {
  neutral: { chip: "bg-muted text-ink-2", dot: "bg-muted-foreground" },
  attention: { chip: "bg-attention-soft text-attention", dot: "bg-attention" },
  error: { chip: "bg-error-soft text-error", dot: "bg-error" },
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
        <WhaleMark className="size-12" />
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
      <h1 className="mt-3 text-balance text-[28px] font-semibold leading-tight tracking-[-0.02em] sm:text-4xl">
        {title}
      </h1>
      <div className="mt-3 max-w-[60ch] text-pretty text-sm leading-relaxed text-muted-foreground">{children}</div>
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
          <div className="mt-2 overflow-x-auto rounded-lg border border-border bg-raised px-3 py-2.5 font-mono text-xs leading-relaxed text-ink-2">
            {details}
          </div>
        </details>
      ) : null}

      <nav aria-label="Main sections" className="mt-12 w-full text-left">
        <p className="mb-2 text-xs text-muted-foreground">Or go to</p>
        <ul className="glass grid overflow-hidden rounded-xl border border-border bg-card sm:grid-cols-2">
          {SECTIONS.map(({ href, label, icon: Icon, hint }, i) => (
            <li
              key={href}
              className={cn(
                "border-border",
                i > 0 && "border-t",
                // Two columns from sm: hairlines between cells, none on the outer edge.
                i === 1 && "sm:border-t-0",
                i % 2 === 1 && "sm:border-l"
              )}
            >
              <Link
                href={href}
                className="group flex items-center gap-3 px-4 py-3 outline-offset-[-2px] transition-colors hover:bg-raised"
              >
                <Icon className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-primary" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{label}</span>
                  <span className="block truncate text-xs text-muted-foreground">{hint}</span>
                </span>
                <ArrowRight
                  className="size-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary motion-reduce:transition-none motion-reduce:group-hover:translate-x-0"
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

/** The one primary action: an indigo control-radius button, with a pressed state. */
export const primaryAction =
  "inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground shadow-card transition-[background-color,transform] duration-[var(--dur-fast)] ease-out hover:bg-primary/90 active:translate-y-px motion-reduce:active:translate-y-0";
/** The quieter alternative: a text link. */
export const secondaryAction =
  "inline-flex items-center gap-1 rounded-md text-sm font-medium text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline";
