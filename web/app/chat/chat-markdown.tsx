"use client";

import Link from "next/link";
import React, { useMemo } from "react";
import { trackEvent } from "@/lib/analytics";
import { classifyHref, parseMarkdown, type Block, type Inline } from "@/lib/chat-markdown";
import { OutboundLink } from "../outbound-link";
import { ResponsiveTable } from "../ui";

/**
 * An answer's Markdown as React elements (the parser: lib/chat-markdown.ts).
 * Nothing is set as HTML. Links go only to this site's pages (client-side
 * navigation, so the conversation survives the visit) or to the public
 * filing hosts; any other link is shown as its text.
 */

const LINK = "font-medium text-foreground underline decoration-foreground/30 underline-offset-[3px] hover:decoration-foreground";

function linkKind(path: string): string {
  if (path.startsWith("/members/")) return "member";
  if (path.startsWith("/tickers/")) return "ticker";
  if (path.startsWith("/insiders/")) return "insider";
  return "page";
}

function Inlines({ nodes, origins }: { nodes: Inline[]; origins: string[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.t) {
          case "text":
            return <React.Fragment key={i}>{n.text}</React.Fragment>;
          case "br":
            return <br key={i} />;
          case "strong":
            return (
              <strong key={i} className="font-semibold text-foreground">
                <Inlines nodes={n.children} origins={origins} />
              </strong>
            );
          case "em":
            return (
              <em key={i}>
                <Inlines nodes={n.children} origins={origins} />
              </em>
            );
          case "code":
            return (
              <code key={i} className="rounded-[5px] bg-fill px-1 py-px font-mono text-[0.92em]">
                {n.text}
              </code>
            );
          case "link": {
            const href = classifyHref(n.href, origins);
            const children = <Inlines nodes={n.children} origins={origins} />;
            if (!href) return <React.Fragment key={i}>{children}</React.Fragment>;
            if (href.kind === "internal") {
              return (
                <Link key={i} href={href.path} className={LINK} onClick={() => trackEvent("chat_link_click", { kind: linkKind(href.path) })}>
                  {children}
                </Link>
              );
            }
            return (
              <OutboundLink key={i} href={href.href} kind="filing" className={LINK}>
                {children}
              </OutboundLink>
            );
          }
        }
      })}
    </>
  );
}

function BlockView({ block, origins }: { block: Block; origins: string[] }) {
  switch (block.t) {
    case "p":
      return (
        <p>
          <Inlines nodes={block.children} origins={origins} />
        </p>
      );
    case "h":
      return (
        <p className="font-semibold text-foreground">
          <Inlines nodes={block.children} origins={origins} />
        </p>
      );
    case "quote":
      return (
        <blockquote className="border-l-2 border-foreground/15 pl-3 text-ink-2">
          <Inlines nodes={block.children} origins={origins} />
        </blockquote>
      );
    case "code":
      return <pre className="overflow-x-auto rounded-control bg-fill px-3 py-2 font-mono text-[12.5px] leading-relaxed">{block.text}</pre>;
    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      return (
        <Tag start={block.ordered && block.start !== 1 ? block.start : undefined} className={block.ordered ? "list-decimal space-y-1 pl-5" : "list-disc space-y-1 pl-5"}>
          {block.items.map((item, i) => (
            <li key={i} className={item.depth ? "ml-5" : undefined}>
              <Inlines nodes={item.children} origins={origins} />
            </li>
          ))}
        </Tag>
      );
    }
    case "table":
      return (
        <ResponsiveTable className="bg-fill/40 shadow-none" stickyFirstColumn={false} wrap>
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-muted-foreground">
                {block.head.map((cell, i) => (
                  <th key={i} scope="col" className="font-medium">
                    <Inlines nodes={cell} origins={origins} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="tabular">
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c} className="align-top">
                      <Inlines nodes={cell} origins={origins} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </ResponsiveTable>
      );
  }
}

export function ChatMarkdown({ text, origins }: { text: string; origins: string[] }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div className="space-y-3 break-words">
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} origins={origins} />
      ))}
    </div>
  );
}
