import { missingAuthConfig } from "@/lib/admin-auth";
import { cn } from "@/lib/utils";
import { Card } from "../charts";
import { BUTTON } from "../ui";
import { signInWithVercel } from "./actions";

/**
 * The gate. A plain form posting to a server action, so it works before
 * hydration and without JavaScript. When sign-in is not configured it says
 * which variables are missing (their names are in the repository anyway)
 * and offers no button: there is nothing to sign in to.
 */
export function AdminSignIn({ error }: { error: "denied" | "failed" | null }) {
  const missing = missingAuthConfig();
  return (
    <Card className="mx-auto w-full max-w-md space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Admin</h1>
        <p className="mt-1 text-sm text-muted-foreground">Contact messages. Sign in with an allowlisted Vercel account.</p>
      </div>
      {error ? (
        <p role="alert" className="rounded-control border border-error/25 bg-error-soft px-3 py-2 text-sm text-error">
          {error === "denied" ? "That account is not allowed in." : "Sign-in did not complete. Try again."}
        </p>
      ) : null}
      {missing.length === 0 ? (
        <form action={signInWithVercel}>
          <button type="submit" className={cn(BUTTON, "h-10 w-full gap-2.5 text-sm text-foreground")}>
            <svg width="14" height="14" viewBox="0 0 76 65" aria-hidden fill="currentColor">
              <path d="M37.5274 0L75.0548 65H0L37.5274 0Z" />
            </svg>
            Sign in with Vercel
          </button>
        </form>
      ) : (
        <div role="status" className="rounded-control border border-attention/25 bg-attention-soft px-3 py-2 text-[13px] text-attention">
          <p className="font-semibold">Sign-in is not configured on this deployment.</p>
          <p className="mt-1">Not set: {missing.join(", ")}.</p>
        </div>
      )}
    </Card>
  );
}
