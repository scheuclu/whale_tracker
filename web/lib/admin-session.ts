import { cache } from "react";

import { auth } from "@/auth";

import { authConfigured, isAllowedAdmin } from "./admin-auth";

/**
 * The signed-in administrator for this request, or null.
 *
 * Checked in the page and in every server action, next to the data, rather
 * than in a layout or proxy: Next 16's authentication guide notes that a
 * layout does not re-run on navigation and that proxy checks are optimistic
 * only, and a server action is its own POST entry point.
 *
 * Fails closed: half-configured sign-in (no secret, no Vercel App, an empty
 * allowlist) never reads a session at all.
 */
export const getAdminSession = cache(async () => {
  if (!authConfigured()) return null;
  const session = await auth();
  const id = session?.user?.id;
  if (!id || !isAllowedAdmin(id)) return null;
  return { id, label: session.user?.name || session.user?.email || id };
});
