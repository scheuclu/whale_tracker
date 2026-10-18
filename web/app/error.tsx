"use client";

import { useEffect } from "react";
import Link from "next/link";
import { RotateCcw } from "lucide-react";
import { StatusScreen, primaryAction, secondaryAction } from "./status-screen";

/**
 * A render that threw. Pages already catch a failed database read and show
 * the message in place, so this is the unexpected case; in production the
 * message is withheld by Next and only the digest (which matches the server
 * log) is shown — both sit behind the "Technical details" disclosure.
 */
export default function ErrorPage({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <StatusScreen
      code="Error"
      tone="error"
      title="This page didn't load"
      action={
        <button type="button" onClick={() => retry()} className={primaryAction}>
          <RotateCcw className="size-3.5" aria-hidden />
          Try again
        </button>
      }
      secondary={
        <Link href="/pipeline" className={secondaryAction}>
          Pipeline status
        </Link>
      }
      details={
        <>
          {error.message ? <p className="whitespace-pre-wrap break-words">{error.message}</p> : null}
          {error.digest ? (
            <p className={error.message ? "mt-1.5 text-muted-foreground" : undefined}>reference {error.digest}</p>
          ) : null}
        </>
      }
    >
      Something went wrong while rendering it. The dashboard reads the pipeline&apos;s database on each
      visit, so a retry usually clears a passing fetch error.
    </StatusScreen>
  );
}
