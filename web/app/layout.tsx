import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { Geist_Mono, Inter, Newsreader } from "next/font/google";
import { ThemeProvider } from "next-themes";
import { Analytics } from "@vercel/analytics/next";
import { BrandMark, Wordmark } from "./brand";
import { HeaderShell } from "./header-shell";
import { SiteFooter } from "./site-footer";
import { NoScriptStyles } from "./no-script";
import { AgentAlternates } from "./agent-alternates";
import { getPipeline } from "@/lib/queries";
// Past this the footer's "Updated" line says the pipeline is behind; /api/health shares the threshold.
import { STALE_AFTER_HOURS } from "@/lib/health";
import { getInsiderTotals } from "@/lib/insider-queries";
import { relativeTime } from "@/lib/format";
import { SITE_DESCRIPTION, SITE_NAME, siteUrl } from "@/lib/site";
import { SearchForm, SearchLink, Tabs, ThemeToggle } from "./nav";
import "./globals.css";
import "./motion.css";

// Self-hosted by next/font (no third-party origin at runtime; the CSP stays
// 'self'), subset to Latin, `swap` with metric-adjusted fallbacks so the
// swap does not shift the layout. Newsreader carries its optical-size axis:
// the same family is a display face at 46px and a text face at 18px.
const sans = Inter({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const serif = Newsreader({
  subsets: ["latin"],
  axes: ["opsz"],
  style: ["normal"],
  variable: "--font-serif",
  display: "swap",
});
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap", preload: false });

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
    { media: "(prefers-color-scheme: light)", color: "#f7f4ed" },
    { media: "(prefers-color-scheme: dark)", color: "#131311" },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  let transactions = 0;
  let insiderTrades = 0;
  let updated = "unavailable";
  let updatedAt: string | null = null;
  let updatedHours: number | null = null;
  try {
    const p = await getPipeline();
    transactions = p.totals.transactions;
    updated = relativeTime(p.lastUpdated);
    updatedAt = p.lastUpdated;
    const t = p.lastUpdated ? Date.parse(p.lastUpdated.replace(" ", "T")) : NaN;
    if (!Number.isNaN(t)) updatedHours = (Date.now() - t) / 3_600_000;
  } catch {
    /* the footer degrades to "unavailable" */
  }
  try {
    insiderTrades = (await getInsiderTotals()).trades;
  } catch {
    /* a database from before the insider source has no such tables */
  }

  return (
    <html lang="en" suppressHydrationWarning className={`${sans.variable} ${serif.variable} ${mono.variable}`}>
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        <AgentAlternates site />
        <NoScriptStyles />
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <HeaderShell>
            {/* One row from 1024px (brand · sections · search · theme). Below
                it the sections take a second row; on a phone that row is the
                only part that stays pinned (globals.css, .site-header). */}
            <div className="mx-auto flex max-w-6xl flex-wrap items-stretch px-4 sm:px-6 lg:flex-nowrap lg:gap-x-10">
              <div className="flex h-12 min-w-0 flex-1 items-center sm:h-14 lg:h-[60px] lg:flex-none">
                <Link
                  href="/"
                  className="group -m-1 flex min-w-0 items-center gap-2 rounded-control p-1 outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring"
                  aria-label="FatCat Watch — feed"
                >
                  <BrandMark className="size-7 transition-transform duration-200 motion-safe:group-hover:-rotate-6" />
                  <Wordmark className="text-[20px] sm:text-[21px]" />
                </Link>
              </div>
              {/* In the DOM between the brand and the tools, so the tab order
                  reads brand → sections → search → theme at every width; below
                  1024px the tools are moved up into the brand row visually. */}
              <Tabs className="order-3 basis-full lg:order-none lg:basis-auto" />
              <div className="order-2 flex h-12 items-center justify-end gap-1 sm:h-14 sm:gap-2 lg:order-none lg:h-[60px] lg:flex-1">
                <SearchForm className="hidden w-60 sm:flex md:w-72 lg:w-64 xl:w-72" />
                <SearchLink className="sm:hidden" />
                <ThemeToggle />
              </div>
            </div>
          </HeaderShell>
          {/* page-flow sets the section rhythm (globals.css): 28px apart on a phone, 40px from sm. */}
          <main className="page-flow mx-auto w-full max-w-6xl px-4 pb-20 pt-7 sm:px-6 sm:pb-24 sm:pt-10">{children}</main>
          <SiteFooter
            transactions={transactions}
            insiderTrades={insiderTrades}
            updated={updated}
            updatedAt={updatedAt}
            stale={updatedHours !== null && updatedHours > STALE_AFTER_HOURS}
          />
        </ThemeProvider>
        <Analytics />
      </body>
    </html>
  );
}
