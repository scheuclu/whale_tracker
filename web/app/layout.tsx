import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import { ThemeProvider } from "next-themes";
import { Analytics } from "@vercel/analytics/next";
import { cn } from "@/lib/utils";
import { WhaleMark, Wordmark } from "./brand";
import { HeaderShell } from "./header-shell";
import { SiteFooter } from "./site-footer";
import { getPipeline } from "@/lib/queries";
import { getInsiderTotals } from "@/lib/insider-queries";
import { relativeTime } from "@/lib/format";
import { SITE_DESCRIPTION, SITE_NAME, siteUrl } from "@/lib/site";
import { SearchForm, Tabs, ThemeToggle } from "./nav";
import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-sans" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono" });

// Defaults only. Every page sets its own title, description and canonical
// through `pageMetadata` (lib/seo.ts); no canonical is set here, because a
// layout-level one would be inherited by any page that forgot its own and
// point it at the home page.
export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: { default: SITE_NAME, template: `%s · ${SITE_NAME}` },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  openGraph: { type: "website", siteName: SITE_NAME, locale: "en_US", title: SITE_NAME, description: SITE_DESCRIPTION },
  twitter: { card: "summary_large_image", title: SITE_NAME, description: SITE_DESCRIPTION },
};

// Browser chrome follows the page surface (--background) in each scheme.
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f7f9" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0c0f" },
  ],
};

/**
 * Past this the sync pill turns amber. The poll is scheduled every 90
 * minutes, but GitHub delivers scheduled runs late and unevenly (a ~5 h
 * median gap), so a few hours without a write is normal, not stale.
 */
const STALE_AFTER_HOURS = 12;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  let transactions = 0;
  let insiderTrades = 0;
  let synced = "unavailable";
  let syncedAt: string | null = null;
  let syncedHours: number | null = null;
  try {
    const p = await getPipeline();
    transactions = p.totals.transactions;
    synced = relativeTime(p.lastUpdated);
    syncedAt = p.lastUpdated;
    const t = p.lastUpdated ? Date.parse(p.lastUpdated.replace(" ", "T")) : NaN;
    if (!Number.isNaN(t)) syncedHours = (Date.now() - t) / 3_600_000;
  } catch {
    /* header degrades to "unavailable" */
  }
  try {
    insiderTrades = (await getInsiderTotals()).trades;
  } catch {
    /* a database from before the insider source has no such tables */
  }
  const syncTone =
    syncedHours === null
      ? "unknown"
      : syncedHours > STALE_AFTER_HOURS
        ? "stale"
        : "fresh";

  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geist.variable} ${geistMono.variable}`}
    >
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <HeaderShell>
            <div className="site-header-top mx-auto flex max-w-6xl items-center gap-3 px-4 pt-4 sm:px-6">
              <Link href="/" className="group flex min-w-0 items-center gap-3 rounded-xl" aria-label="Whale Tracker — feed">
                <WhaleMark className="site-header-mark motion-safe:group-hover:-rotate-6" />
                <div className="min-w-0">
                  <Wordmark className="block" />
                  {/* Each count stays whole; on a phone the second wraps under the first. */}
                  <div className="site-header-sub tabular overflow-hidden text-xs leading-snug text-muted-foreground">
                    <span className="whitespace-nowrap">
                      {transactions.toLocaleString()} congressional{insiderTrades ? " ·" : " trades"}
                    </span>
                    {insiderTrades ? (
                      <>
                        {" "}
                        <span className="whitespace-nowrap">{insiderTrades.toLocaleString()} insider trades</span>
                      </>
                    ) : null}
                  </div>
                </div>
              </Link>
              <div className="flex-1" />
              <Link
                href="/pipeline"
                title={syncedAt ? `Last pipeline write: ${syncedAt} — open Pipeline` : "Open Pipeline"}
                className="inline-flex shrink-0 items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
              >
                <span className="relative flex size-1.5" aria-hidden>
                  {syncTone === "fresh" ? (
                    <span className="absolute inline-flex size-full rounded-full bg-emerald-500 opacity-60 motion-safe:animate-ping" />
                  ) : null}
                  <span
                    className={cn(
                      "relative inline-flex size-1.5 rounded-full",
                      syncTone === "fresh" && "bg-emerald-500",
                      syncTone === "stale" && "bg-amber-500",
                      syncTone === "unknown" && "bg-zinc-400"
                    )}
                  />
                </span>
                <span className="tabular">
                  <span className="sr-only sm:not-sr-only">synced </span>
                  {synced}
                  {syncTone === "stale" ? <span className="sr-only"> (stale)</span> : null}
                </span>
              </Link>
              <ThemeToggle />
            </div>
            <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
              <Tabs />
              <SearchForm className="ml-auto" />
            </div>
          </HeaderShell>
          {/* page-flow sets the section rhythm (globals.css): 28px apart on a phone, 40px from sm. */}
          <main className="page-flow mx-auto w-full max-w-6xl px-4 pb-20 pt-7 sm:px-6 sm:pb-24 sm:pt-10">{children}</main>
          <SiteFooter />
        </ThemeProvider>
        <Analytics />
      </body>
    </html>
  );
}
