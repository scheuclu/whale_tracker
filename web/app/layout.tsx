import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ThemeProvider } from "next-themes";
import { Landmark } from "lucide-react";
import { getPipeline } from "@/lib/queries";
import { getInsiderTotals } from "@/lib/insider-queries";
import { relativeTime } from "@/lib/format";
import { Tabs, ThemeToggle } from "./nav";
import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-sans" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "Whale Tracker",
  description:
    "US congressional and corporate-insider stock trades: tickers, volume, and who is trading",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  let transactions = 0;
  let insiderTrades = 0;
  let synced = "unavailable";
  try {
    const p = await getPipeline();
    transactions = p.totals.transactions;
    synced = relativeTime(p.lastUpdated);
  } catch {
    /* header degrades to "unavailable" */
  }
  try {
    insiderTrades = (await getInsiderTotals()).trades;
  } catch {
    /* a database from before the insider source has no such tables */
  }

  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geist.variable} ${geistMono.variable}`}
    >
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <header className="sticky top-0 z-30 border-b border-border/70 bg-background/60 backdrop-blur-xl">
            <div className="mx-auto flex max-w-6xl items-center gap-3 px-6 pt-4">
              <div className="brand-mark flex size-9 items-center justify-center rounded-xl">
                <Landmark className="size-[18px] text-white" aria-hidden />
              </div>
              <div className="min-w-0">
                <div className="text-[15px] font-semibold leading-tight tracking-tight">
                  Whale <span className="text-primary">Tracker</span>
                </div>
                <div className="text-xs text-muted-foreground">
                  {transactions.toLocaleString()} congressional
                  {insiderTrades ? ` · ${insiderTrades.toLocaleString()} insider` : ""} trades
                </div>
              </div>
              <div className="flex-1" />
              <span className="hidden items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground sm:inline-flex">
                <span className="relative flex size-1.5">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-60" />
                  <span className="relative inline-flex size-1.5 rounded-full bg-emerald-500" />
                </span>
                synced {synced}
              </span>
              <ThemeToggle />
            </div>
            <div className="mx-auto max-w-6xl px-6 py-3">
              <Tabs />
            </div>
          </header>
          <main className="mx-auto max-w-6xl px-6 py-8 pb-28">{children}</main>
          <footer className="mx-auto max-w-6xl px-6 pb-10 text-xs leading-relaxed text-muted-foreground">
            Sources: US House Clerk and US Senate eFD periodic transaction reports
            (STOCK Act disclosures) and SEC EDGAR Form 4 filings. Members disclose an{" "}
            <strong>amount bracket</strong>, not an exact figure — every congressional
            total here is a range, and any midpoint is an estimate. Insider values
            are <strong>shares × the reported price</strong>, which the filer may state
            as a weighted average. Paper filings in either chamber are not read; see
            Pipeline.
          </footer>
        </ThemeProvider>
      </body>
    </html>
  );
}
