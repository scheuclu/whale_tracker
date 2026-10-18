"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Activity, RotateCcw } from "lucide-react";
import { StatusScreen, primaryAction, secondaryAction } from "./status-screen";

/**
 * A render that threw. Pages already catch a failed database read and show
 * the message in place, so this is the unexpected case; in production the
 * message is withheld by Next and only the digest (which matches the server
 * log) is shown.
 */
export default function ErrorPage({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <StatusScreen
      code="error"
      title="This page didn't load"
      actions={
        <>
          <button type="button" onClick={() => retry()} className={primaryAction}>
            <RotateCcw className="size-3.5" aria-hidden />
            Try again
          </button>
          <Link href="/pipeline" className={secondaryAction}>
            <Activity className="size-3.5" aria-hidden />
            Pipeline status
          </Link>
        </>
      }
    >
      <p>
        Something went wrong while rendering it. The dashboard reads the pipeline&apos;s database on
        each visit, so a retry usually clears a passing fetch error.
      </p>
      {error.digest ? (
        <p className="mt-2 font-mono text-[11px] text-muted-foreground/80">reference {error.digest}</p>
      ) : null}
    </StatusScreen>
  );
}
