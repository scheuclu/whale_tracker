import assert from "node:assert/strict";
import { test } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Every <table> under app/ must sit inside <ResponsiveTable> (app/ui.tsx).
// A bare table is wider than a phone on every page of this dashboard, and a
// Card with `overflow-x-auto` hides that from the document's scrollWidth
// without telling the reader the table scrolls. Issue #49 found all eight
// routes overflowing at 390px; this keeps a new page from reopening it.

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "app");

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return tsxFiles(p);
    return name.endsWith(".tsx") ? [p] : [];
  });
}

const files = tsxFiles(APP);

test("the app directory was found and has pages in it", () => {
  assert.ok(files.some((f) => f.endsWith(path.join("app", "page.tsx"))), `no app/page.tsx under ${APP}`);
});

// Markup only: the JSDoc on ResponsiveTable itself quotes the pattern it replaces.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

for (const file of files) {
  const src = stripComments(readFileSync(file, "utf8"));
  const tables = (src.match(/<table\b/g) ?? []).length;
  if (!tables) continue;
  const rel = path.relative(path.dirname(APP), file);

  test(`${rel}: every <table> is wrapped in <ResponsiveTable>`, () => {
    const wrappers = (src.match(/<ResponsiveTable\b/g) ?? []).length;
    assert.ok(
      /import\s*\{[^}]*\bResponsiveTable\b[^}]*\}\s*from\s*["'][^"']*\/ui["']/.test(src),
      `${rel} renders a <table> but does not import ResponsiveTable from app/ui`
    );
    assert.ok(
      wrappers >= tables,
      `${rel} has ${tables} <table> element(s) but only ${wrappers} <ResponsiveTable> wrapper(s)`
    );
  });

  test(`${rel}: no Card doubles as the table's scroll container`, () => {
    // `overflow-x-auto` on the Card was the pre-#49 pattern; the wrapper owns
    // scrolling now, and two nested scroll containers trap the edge fade.
    assert.ok(
      !/<Card[^>]*overflow-x-auto/.test(src),
      `${rel} still puts overflow-x-auto on a Card around a table`
    );
  });
}
