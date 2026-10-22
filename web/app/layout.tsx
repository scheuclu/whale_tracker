import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { Geist_Mono, Inter } from "next/font/google";
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

// The type is the system UI stack (globals.css, `--font-sans` /
// `--font-display`): Apple devices render SF Pro, which may not be embedded
// on the web. Inter is the fallback everywhere else — self-hosted by
// next/font (no third-party origin at runtime; the CSP stays 'self'),
// subset to Latin, `swap` with a metric-adjusted fallback. Not preloaded:
// a Mac or an iPhone never needs it, and a preload would fetch it anyway.
// Geist Mono is for filing ids and code only.
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap", preload: false });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono", display: "swap", preload: false });

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
    { media: "(prefers-color-scheme: light)", color: "#f5f5f7" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
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
    <html lang="en" suppressHydrationWarning className={`${inter.variable} ${mono.variable}`}>
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        <AgentAlternates site />
        <NoScriptStyles />
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <HeaderShell>
            {/* One row from 1024px (brand · sections · search · theme), 52px
                like apple.com's nav. Below it the sections take a second row;
                on a phone that row is the only part that stays pinned
                (globals.css, .site-header). */}
            <div className="mx-auto flex max-w-[1080px] flex-wrap items-stretch px-4 sm:px-6 lg:flex-nowrap lg:gap-x-8">
              <div className="flex h-12 min-w-0 flex-1 items-center lg:h-[52px] lg:flex-none">
                <Link
                  href="/"
                  className="group -m-1 flex min-w-0 items-center gap-2 rounded-[10px] p-1 outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring"
                  aria-label="FatCat Watch — feed"
                >
                  <BrandMark className="size-[26px] transition-transform duration-200 ease-out motion-safe:group-hover:-rotate-6" />
                  <Wordmark className="text-[18px]" />
                </Link>
              </div>
              {/* In the DOM between the brand and the tools, so the tab order
                  reads brand → sections → search → theme at every width; below
                  1024px the tools are moved up into the brand row visually. */}
              <Tabs className="order-3 basis-full lg:order-none lg:basis-auto" />
              <div className="order-2 flex h-12 items-center justify-end gap-1.5 sm:gap-2 lg:order-none lg:h-[52px] lg:flex-1">
                <SearchForm className="hidden w-56 sm:flex md:w-64 lg:w-52 xl:w-60" />
                <SearchLink className="sm:hidden" />
                <ThemeToggle />
              </div>
            </div>
          </HeaderShell>
          {/* page-flow sets the section rhythm (globals.css): 28px apart on a phone, 40px from sm. */}
          <main className="page-flow mx-auto w-full max-w-[1080px] px-4 pb-20 pt-6 sm:px-6 sm:pb-28 sm:pt-12">{children}</main>
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
