import { expect, test, visit } from "./fixtures";

/**
 * The project's non-negotiable: congressional amounts are ranges. A bracket
 * collapsed to one number without an "est." label is a bug (CLAUDE.md).
 *
 * Two checks over rendered pages, both keyed on markup the components own:
 *
 * - `BracketAmount` (app/bracket-glyph.tsx) draws an svg carrying
 *   `data-bracket-kind`, followed by the disclosed text. The text must say
 *   what the kind says: a range is "$lo–$hi", an open top bracket "≥$floor"
 *   with no ceiling, an exact figure is flagged "exact".
 * - `StatTile` (app/charts.tsx): a tile showing a single dollar figure must
 *   say it is an estimate (bracket midpoints) — or, for Form 4, that it is
 *   shares × the reported price.
 *
 * Each check also asserts it found something, so a markup change that makes
 * the selector match nothing fails here instead of passing vacuously.
 */
test.describe.configure({ mode: "parallel" });

const FIGURE = String.raw`\$[\d,.]+[kMBT]?`;
const RANGE = new RegExp(`^${FIGURE}–${FIGURE}$`);
const OPEN = new RegExp(`^≥${FIGURE}$`);
const SINGLE = new RegExp(`^-?${FIGURE}$`);

const BRACKET_PAGES = ["/", "/members/nancy-pelosi-p000197", "/tickers/MSFT", "/?action=sell"];

for (const path of BRACKET_PAGES) {
  test(`amounts render as disclosed ranges on ${path}`, async ({ page }) => {
    await visit(page, path);
    const amounts = await page.locator("svg[data-bracket-kind]").evaluateAll((svgs) =>
      svgs.map((svg) => {
        const holder = svg.parentElement!;
        const money = holder.querySelector(":scope > .tabular");
        return {
          kind: svg.getAttribute("data-bracket-kind"),
          text: (money?.textContent ?? "").replace(/\s+/g, ""),
          exactTag: [...holder.children].some((c) => c.textContent?.trim().toLowerCase() === "exact"),
          title: holder.getAttribute("title") ?? "",
        };
      })
    );
    expect(amounts.length, "bracket amounts on the page").toBeGreaterThan(5);
    for (const a of amounts) {
      const where = `${a.kind} "${a.text}" (${a.title})`;
      switch (a.kind) {
        case "range":
          expect(a.text, `a range must print both ends: ${where}`).toMatch(RANGE);
          break;
        case "open":
          expect(a.text, `an open bracket prints its floor only: ${where}`).toMatch(OPEN);
          break;
        case "exact":
          expect(a.text, where).toMatch(SINGLE);
          expect(a.exactTag, `an exact figure is labelled "exact": ${where}`).toBe(true);
          break;
        case "unknown":
          expect(a.text, where).toBe("—");
          break;
        default:
          throw new Error(`unexpected bracket kind: ${where}`);
      }
    }
  });
}

/** Every congressional trade row carries a bracket, not a bare figure. */
test("every feed row renders its bracket", async ({ page }) => {
  await visit(page, "/");
  const rows = page.locator("li.feed-row");
  expect(await rows.count()).toBeGreaterThan(10);
  const missing = await rows.evaluateAll((els) => els.filter((li) => !li.querySelector("svg[data-bracket-kind]")).length);
  expect(missing, "feed rows without a bracket amount").toBe(0);
});

const TILE_PAGES = [
  "/politicians",
  "/members/nancy-pelosi-p000197",
  "/tickers/MSFT",
  "/insiders",
  "/insiders?t=BBD",
  "/trends",
];

for (const path of TILE_PAGES) {
  test(`single-figure stat tiles are labelled as estimates on ${path}`, async ({ page }) => {
    await visit(page, path);
    const tiles = await page.locator("div.viz-rise.rounded-xl").evaluateAll((els) =>
      els.map((t) => ({
        label: t.querySelector(":scope > div:first-child > div:first-child")?.textContent?.trim() ?? "",
        value: (t.querySelector(":scope > div:nth-child(2) > div:first-child")?.textContent ?? "").replace(/\s+/g, ""),
        text: (t as HTMLElement).innerText,
      }))
    );
    expect(tiles.length, "stat tiles on the page").toBeGreaterThan(0);
    const dollarTiles = tiles.filter((t) => t.value.includes("$"));
    expect(dollarTiles.length, "a dollar tile on the page").toBeGreaterThan(0);
    for (const t of dollarTiles) {
      if (!SINGLE.test(t.value)) continue; // a range or ≥floor says what it is
      expect(
        t.text,
        `"${t.label}" shows ${t.value} as one number: it must say "est." / "estimated" or "shares × reported price"`
      ).toMatch(/\best(\.|imated?\b)|shares × reported price/i);
    }
  });
}

test("leaderboard volume columns are headed as estimates", async ({ page }) => {
  for (const path of ["/politicians", "/tickers"]) {
    await visit(page, path);
    const headers = await page.locator("thead th").allTextContents();
    const volume = headers.filter((h) => /volume/i.test(h));
    expect(volume.length, `${path} has a volume column`).toBeGreaterThan(0);
    for (const h of volume) expect(h, `${path}: "${h}"`).toMatch(/\(est\.\)/);
  }
});
