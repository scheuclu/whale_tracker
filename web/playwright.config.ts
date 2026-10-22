import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end smoke tests against a production build (`next build` then
 * `next start`) reading the committed `data/trades.sqlite3`.
 *
 * Canonicals, the sitemap and robots.txt are absolute URLs built on
 * `NEXT_PUBLIC_SITE_URL`, which Next inlines at *build* time — so build with
 * it pointing at the port the tests use:
 *
 *   NEXT_PUBLIC_SITE_URL=http://localhost:3245 npm run build
 *   npm run test:e2e
 *
 * `e2e/global-setup.ts` checks that and says so if the build disagrees.
 * The server is started here (or reused locally if one is already up on the
 * port); CI builds in its own step so a type error fails the build step.
 */
const PORT = Number(process.env.E2E_PORT ?? 3245);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;
const CI = !!process.env.CI;

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  workers: CI ? 4 : undefined,
  timeout: 30_000,
  expect: { timeout: 7_500 },
  reporter: CI ? [["github"], ["list"], ["html", { open: "never" }]] : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // Fixed so dates and the theme default render the same on every machine.
    colorScheme: "light",
    timezoneId: "America/New_York",
    locale: "en-US",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: `npx next start -p ${PORT}`,
        url: `${BASE_URL}/robots.txt`,
        reuseExistingServer: !CI,
        timeout: 60_000,
        stdout: "ignore",
        stderr: "pipe",
      },
});
