import Link from "next/link";
import { ArrowRight, Briefcase, Landmark, LineChart, Receipt } from "lucide-react";
import { WhaleMark } from "./brand";

/**
 * The shared body of not-found.tsx and error.tsx: the mark, what happened,
 * the page's own actions, and a way back into the main sections. No hooks,
 * so it renders from the server 404 and the client error boundary alike.
 */
const SECTIONS = [
  { href: "/", label: "Feed", icon: Receipt, hint: "Latest disclosed trades" },
  { href: "/tickers", label: "Tickers", icon: LineChart, hint: "What is being traded" },
  { href: "/politicians", label: "Politicians", icon: Landmark, hint: "Who is trading" },
  { href: "/insiders", label: "Insiders", icon: Briefcase, hint: "Form 4 open-market trades" },
];

export function StatusScreen({
  code,
  title,
  children,
  actions,
}: {
  code: string;
  title: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mx-auto flex max-w-2xl flex-col items-center py-6 text-center sm:py-12">
      <div className="status-mark relative">
        <WhaleMark className="size-14" />
      </div>
      <p className="mt-6 font-mono text-xs font-medium uppercase tracking-[0.2em] text-primary">{code}</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
      <div className="mt-3 max-w-lg text-sm leading-relaxed text-muted-foreground">{children}</div>
      {actions ? <div className="mt-6 flex flex-wrap items-center justify-center gap-2">{actions}</div> : null}

      <nav aria-label="Main sections" className="mt-10 grid w-full grid-cols-1 gap-2 text-left sm:grid-cols-2">
        {SECTIONS.map(({ href, label, icon: Icon, hint }) => (
          <Link
            key={href}
            href={href}
            className="glass lift group flex items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3"
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Icon className="size-4" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{label}</span>
              <span className="block truncate text-xs text-muted-foreground">{hint}</span>
            </span>
            <ArrowRight
              className="size-3.5 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary"
              aria-hidden
            />
          </Link>
        ))}
      </nav>
    </div>
  );
}

/** Button styles for the screen's own actions. */
export const primaryAction =
  "inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition-opacity hover:opacity-90";
export const secondaryAction =
  "inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground";
