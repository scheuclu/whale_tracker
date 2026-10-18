import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import { ThemeProvider } from "next-themes";
import { Analytics } from "@vercel/analytics/next";
import { WhaleMark, Wordmark } from "./brand";
import { HeaderShell } from "./header-shell";
import { SiteFooter } from "./site-footer";
import { getPipeline } from "@/lib/queries";
import { getInsiderTotals } from "@/lib/insider-queries";
import { relativeTime } from "@/lib/format";
import { SearchForm, SyncStatus, Tabs, ThemeToggle } from "./nav";
import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-sans" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono" });

const DESCRIPTION =
  "US congressional and corporate-insider stock trades: tickers, volume, and who is trading";

export const metadata: Metadata = {
  title: { default: "Whale Tracker", template: "%s · Whale Tracker" },
  description: DESCRIPTION,
  applicationName: "Whale Tracker",
  openGraph: { type: "website", siteName: "Whale Tracker", title: "Whale Tracker", description: DESCRIPTION },
  twitter: { card: "summary_large_image", title: "Whale Tracker", description: DESCRIPTION },
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
  const syncTone: "fresh" | "stale" | "unknown" =
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
            <div className="site-header-top mx-auto flex max-w-6xl items-center gap-2 px-4 pt-3.5 sm:px-6">
              <Link
                href="/"
                className="group -m-1 flex min-w-0 items-center gap-2.5 rounded-[10px] p-1 outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-primary"
                aria-label="Whale Tracker — feed"
              >
                <WhaleMark className="site-header-mark size-8 motion-safe:group-hover:-rotate-6" />
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
              <SyncStatus synced={synced} syncedAt={syncedAt} tone={syncTone} />
              <span className="h-4 w-px bg-border" aria-hidden />
              <ThemeToggle />
            </div>
            {/* Tabs sit on the header's bottom edge so the active underline meets
                its hairline; on a phone the search takes its own row above them. */}
            <div className="mx-auto flex max-w-6xl flex-wrap items-end gap-x-6 gap-y-2.5 px-4 pt-3 pb-0! sm:flex-nowrap sm:px-6">
              <Tabs />
              <SearchForm className="order-first basis-full sm:order-none sm:mb-1 sm:ml-auto sm:w-72 sm:shrink-0 sm:basis-auto lg:w-80" />
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
