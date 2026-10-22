"use server";

import { AuthError } from "next-auth";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { signIn, signOut } from "@/auth";
import { authConfigured } from "@/lib/admin-auth";
import { getAdminSession } from "@/lib/admin-session";
import { contactBackend } from "@/lib/contact-blob";
import { setMessageHandled } from "@/lib/contact-store";

/**
 * Every action re-checks the caller: a server action is its own POST entry
 * point, and the page having shown a sign-in panel proves nothing about who
 * is calling this.
 */

export async function signInWithVercel() {
  if (!authConfigured()) redirect("/admin");
  try {
    await signIn("vercel", { redirectTo: "/admin" });
  } catch (error) {
    // Success throws too (NEXT_REDIRECT) and must carry on; only a refusal
    // lands on the panel's "not allowed" note.
    if (error instanceof AuthError) redirect("/admin?error=AccessDenied");
    throw error;
  }
}

export async function signOutAdmin() {
  if (!authConfigured()) redirect("/admin");
  await signOut({ redirectTo: "/admin" });
}

/** Mark a message dealt with, or reopen it. Bound to (id, handled) by the page. */
export async function toggleHandled(id: string, handled: boolean) {
  if (!(await getAdminSession())) throw new Error("Unauthorized");
  const backend = contactBackend();
  if (!backend) throw new Error("No contact store is connected");
  await setMessageHandled(backend, id, handled);
  revalidatePath("/admin");
}
