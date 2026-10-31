import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyHref, parseInline, parseMarkdown } from "./chat-markdown.ts";

const OWN = ["http://localhost:3245", "https://www.fatcatwatch.com"];

describe("parseMarkdown", () => {
  it("reads paragraphs, line breaks, bold, italic, code and links", () => {
    assert.deepEqual(parseMarkdown("**Two** members bought *NVDA*.\nSee `NVDA` on [its page](/tickers/NVDA)."), [
      {
        t: "p",
        children: [
          { t: "strong", children: [{ t: "text", text: "Two" }] },
          { t: "text", text: " members bought " },
          { t: "em", children: [{ t: "text", text: "NVDA" }] },
          { t: "text", text: "." },
          { t: "br" },
          { t: "text", text: "See " },
          { t: "code", text: "NVDA" },
          { t: "text", text: " on " },
          { t: "link", href: "/tickers/NVDA", children: [{ t: "text", text: "its page" }] },
          { t: "text", text: "." },
        ],
      },
    ]);
  });

  it("reads lists, numbered lists and nesting", () => {
    const blocks = parseMarkdown("Top buyers:\n\n- A\n  - A's spouse\n- B\n\n3. third\n4. fourth");
    assert.equal(blocks.length, 3);
    assert.deepEqual(blocks[1], {
      t: "list",
      ordered: false,
      start: 1,
      items: [
        { depth: 0, children: [{ t: "text", text: "A" }] },
        { depth: 1, children: [{ t: "text", text: "A's spouse" }] },
        { depth: 0, children: [{ t: "text", text: "B" }] },
      ],
    });
    assert.equal(blocks[2].t === "list" && blocks[2].ordered && blocks[2].start, 3);
  });

  it("reads a pipe table, padding short rows", () => {
    const [table] = parseMarkdown("| Member | Range |\n|---|---:|\n| A | $1,001–$15,000 |\n| B |");
    assert.equal(table.t, "table");
    if (table.t !== "table") return;
    assert.equal(table.head.length, 2);
    assert.equal(table.rows.length, 2);
    assert.deepEqual(table.rows[0][1], [{ t: "text", text: "$1,001–$15,000" }]);
    assert.deepEqual(table.rows[1][1], []);
  });

  it("keeps HTML and unknown syntax as plain text", () => {
    const blocks = parseMarkdown("<script>alert(1)</script> <img src=x onerror=y>");
    assert.deepEqual(blocks, [{ t: "p", children: [{ t: "text", text: "<script>alert(1)</script> <img src=x onerror=y>" }] }]);
  });

  it("reads fenced code verbatim and survives unbalanced markers", () => {
    assert.deepEqual(parseMarkdown("```\n**not bold**\n```"), [{ t: "code", text: "**not bold**" }]);
    assert.deepEqual(parseInline("a ** b [c"), [{ t: "text", text: "a ** b [c" }]);
    assert.deepEqual(parseInline("5 * 3 = 15"), [{ t: "text", text: "5 * 3 = 15" }]);
  });
});

describe("classifyHref", () => {
  it("keeps this site's pages in the app, absolute or relative", () => {
    assert.deepEqual(classifyHref("/members/nancy-pelosi-p000197", OWN), { kind: "internal", path: "/members/nancy-pelosi-p000197" });
    assert.deepEqual(classifyHref("https://www.fatcatwatch.com/tickers/NVDA?x=1#insiders", OWN), {
      kind: "internal",
      path: "/tickers/NVDA?x=1#insiders",
    });
  });

  it("lets through the public filing hosts, over https only", () => {
    const pdf = "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20012345.pdf";
    assert.deepEqual(classifyHref(pdf, OWN), { kind: "external", href: pdf });
    assert.equal(classifyHref("https://www.sec.gov/Archives/edgar/data/1/x.xml", OWN)?.kind, "external");
    assert.equal(classifyHref("http://www.sec.gov/x", OWN), null);
  });

  it("drops everything else", () => {
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,<b>x</b>",
      "//evil.example/x",
      "/\\evil.example",
      "https://evil.example/members/x",
      "https://www.fatcatwatch.com.evil.example/",
      "https://user:pw@www.fatcatwatch.com/",
      "mailto:a@b.c",
      "",
    ]) {
      assert.equal(classifyHref(bad, OWN), null, bad);
    }
  });
});
