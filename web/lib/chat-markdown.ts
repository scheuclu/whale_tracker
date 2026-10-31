/**
 * The chat's answers are Markdown written by a model, so they are parsed
 * here into a small tree and rendered as React elements
 * (`app/chat/chat-markdown.tsx`): never set as HTML, so a model reply can
 * contain no markup, script or style at all. Pure, for the tests.
 *
 * Supported: paragraphs (single newlines kept as line breaks), headings,
 * bullet and numbered lists (one level of nesting), pipe tables, fenced
 * code, **bold**, *italic*, `code` and [links](url). Anything else is text.
 *
 * Links are the one way an answer can send a reader somewhere, so
 * `classifyHref` lets through only this site's own pages and the public
 * filing hosts the data cites; any other link is shown as its text alone.
 */

export type Inline =
  | { t: "text"; text: string }
  | { t: "br" }
  | { t: "strong"; children: Inline[] }
  | { t: "em"; children: Inline[] }
  | { t: "code"; text: string }
  | { t: "link"; href: string; children: Inline[] };

export type Block =
  | { t: "p"; children: Inline[] }
  | { t: "h"; children: Inline[] }
  | { t: "list"; ordered: boolean; start: number; items: { depth: number; children: Inline[] }[] }
  | { t: "table"; head: Inline[][]; rows: Inline[][][] }
  | { t: "code"; text: string }
  | { t: "quote"; children: Inline[] };

/* ------------------------------------------------------------------ inlines */

function closingBracket(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "\\") {
      i++;
      continue;
    }
    if (s[i] === "[") depth++;
    else if (s[i] === "]" && --depth === 0) return i;
  }
  return -1;
}

export function parseInline(s: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push({ t: "text", text: buf });
    buf = "";
  };
  if (depth > 4) return [{ t: "text", text: s }];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length && /[\\`*_[\]()#|>-]/.test(s[i + 1])) {
      buf += s[i + 1];
      i += 2;
      continue;
    }
    if (c === "`") {
      const j = s.indexOf("`", i + 1);
      if (j > i + 1) {
        flush();
        out.push({ t: "code", text: s.slice(i + 1, j) });
        i = j + 1;
        continue;
      }
    }
    if (c === "*" && s[i + 1] === "*") {
      const j = s.indexOf("**", i + 2);
      if (j > i + 2) {
        flush();
        out.push({ t: "strong", children: parseInline(s.slice(i + 2, j), depth + 1) });
        i = j + 2;
        continue;
      }
    }
    if (c === "*" && s[i + 1] && s[i + 1] !== " " && s[i + 1] !== "*") {
      const j = s.indexOf("*", i + 1);
      if (j > i + 1 && s[j - 1] !== " ") {
        flush();
        out.push({ t: "em", children: parseInline(s.slice(i + 1, j), depth + 1) });
        i = j + 1;
        continue;
      }
    }
    if (c === "[") {
      const close = closingBracket(s, i);
      if (close > i && s[close + 1] === "(") {
        const end = s.indexOf(")", close + 2);
        if (end > close + 2) {
          flush();
          out.push({ t: "link", href: s.slice(close + 2, end).trim(), children: parseInline(s.slice(i + 1, close), depth + 1) });
          i = end + 1;
          continue;
        }
      }
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

/** Lines joined by line breaks, each parsed for inlines. */
function inlineLines(lines: string[]): Inline[] {
  const out: Inline[] = [];
  lines.forEach((l, i) => {
    if (i > 0) out.push({ t: "br" });
    out.push(...parseInline(l));
  });
  return out;
}

/* ------------------------------------------------------------------- blocks */

const FENCE = /^\s*```/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,3})[.)]\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;

function cells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim());
}

function isTableStart(lines: string[], i: number): boolean {
  return lines[i].includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes("-");
}

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const endPara = () => {
    if (para.length) blocks.push({ t: "p", children: inlineLines(para) });
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      endPara();
      continue;
    }
    if (FENCE.test(line)) {
      endPara();
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i])) body.push(lines[i++]);
      blocks.push({ t: "code", text: body.join("\n") });
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      endPara();
      blocks.push({ t: "h", children: parseInline(h[1]) });
      continue;
    }
    if (RULE.test(line)) {
      endPara();
      continue;
    }
    if (isTableStart(lines, i)) {
      endPara();
      const head = cells(line).map((c) => parseInline(c));
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        const row = cells(lines[i]).map((c) => parseInline(c));
        while (row.length < head.length) row.push([]);
        rows.push(row.slice(0, head.length));
        i++;
      }
      i--;
      blocks.push({ t: "table", head, rows });
      continue;
    }
    const b = BULLET.exec(line);
    const o = b ? null : ORDERED.exec(line);
    if (b || o) {
      endPara();
      const ordered = !!o;
      const items: { depth: number; children: Inline[] }[] = [];
      const start = o ? Number(o[2]) : 1;
      for (; i < lines.length; i++) {
        const lb = BULLET.exec(lines[i]);
        const lo = lb ? null : ORDERED.exec(lines[i]);
        const m = lb ?? lo;
        if (m) {
          const indent = m[1].replace(/\t/g, "  ").length;
          items.push({ depth: indent >= 2 ? 1 : 0, children: parseInline(lb ? lb[2] : lo![3]) });
          continue;
        }
        // A wrapped line continues the item above it.
        if (lines[i].trim() && /^\s+/.test(lines[i]) && items.length) {
          items[items.length - 1].children.push({ t: "br" }, ...parseInline(lines[i].trim()));
          continue;
        }
        break;
      }
      i--;
      blocks.push({ t: "list", ordered, start, items });
      continue;
    }
    const q = QUOTE.exec(line);
    if (q) {
      endPara();
      const body: string[] = [q[1]];
      while (i + 1 < lines.length && QUOTE.test(lines[i + 1])) body.push(QUOTE.exec(lines[++i])![1]);
      blocks.push({ t: "quote", children: inlineLines(body) });
      continue;
    }
    para.push(line.trim());
  }
  endPara();
  return blocks;
}

/* -------------------------------------------------------------------- links */

/** The public hosts whose filings the data links to (`source_url`). */
export const FILING_HOSTS = new Set([
  "disclosures-clerk.house.gov",
  "efdsearch.senate.gov",
  "www.sec.gov",
  "sec.gov",
]);

export type Href = { kind: "internal"; path: string } | { kind: "external"; href: string } | null;

/**
 * Where a link in an answer may go. `ownOrigins` are this deployment's
 * origin and the canonical site URL (tool results carry the canonical one,
 * so on a preview deployment those links stay inside the preview).
 */
export function classifyHref(raw: string, ownOrigins: string[]): Href {
  const href = raw.trim().replace(/^<|>$/g, "");
  if (href.startsWith("/") && !href.startsWith("//") && !href.startsWith("/\\")) {
    return /[\u0000-\u001f\s]/.test(href) ? null : { kind: "internal", path: href };
  }
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  const own = new Set(
    ownOrigins.flatMap((o) => {
      try {
        return [new URL(o).origin];
      } catch {
        return [];
      }
    })
  );
  if (own.has(url.origin)) return { kind: "internal", path: `${url.pathname}${url.search}${url.hash}` };
  if (url.protocol === "https:" && FILING_HOSTS.has(url.hostname)) return { kind: "external", href: url.toString() };
  return null;
}
