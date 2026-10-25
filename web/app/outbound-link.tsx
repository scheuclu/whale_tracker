"use client";

import React from "react";
import { trackEvent } from "@/lib/analytics";

/**
 * An outbound link that tracks clicks in Vercel Web Analytics.
 * Used for primary documents: Clerk PDFs, Senate eFD, and SEC Form 4 EDGAR filings.
 */
export function OutboundLink({
  href,
  kind = "filing",
  className,
  children,
  ...rest
}: {
  href: string;
  kind?: "pdf" | "filing" | "clerk" | "edgar" | "external";
  className?: string;
  children: React.ReactNode;
} & React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={className}
      onClick={() => trackEvent("outbound_click", { destination: href, kind })}
      {...rest}
    >
      {children}
    </a>
  );
}
