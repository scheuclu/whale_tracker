"use server";

import { headers } from "next/headers";

import {
  CONTACT_COPY,
  EMPTY_CONTACT_FIELDS,
  isRateLimited,
  looksLikeBot,
  rateLimitSince,
  readContactFields,
  validateContact,
  type ContactState,
} from "@/lib/contact";
import { clientIpFrom, hashIp } from "@/lib/contact-ip";
import { contactBackend, contactConfigured } from "@/lib/contact-blob";
import { countRecentMessagesFrom, saveContactMessage } from "@/lib/contact-store";

/**
 * Receive a message from /contact.
 *
 * A server action so the form works with no client JavaScript: the browser
 * posts natively and React renders this function's result into the page it
 * sends back. Its response is never cached — /contact is outside the CDN
 * page rule (lib/cache-policy.ts) and Next marks action responses no-store.
 */
export async function submitContactMessage(_previous: ContactState, formData: FormData): Promise<ContactState> {
  const fields = readContactFields(formData);

  /* A filled honeypot is answered exactly as a success, and nothing is
     stored: telling a bot it failed teaches it which field to leave alone. */
  if (looksLikeBot(formData)) {
    return { status: "sent", errors: {}, values: EMPTY_CONTACT_FIELDS };
  }

  const validated = validateContact(fields);
  if (!validated.ok) return { status: "error", errors: validated.errors, values: fields };

  const backend = contactBackend();
  if (!backend || !contactConfigured()) {
    return { status: "error", errors: {}, formError: CONTACT_COPY.unavailable, values: fields };
  }

  const requestHeaders = await headers();
  const ipHash = hashIp(clientIpFrom((name) => requestHeaders.get(name)));

  try {
    // No forwarding header means no per-sender limit rather than one shared
    // bucket everybody falls into. Vercel always sends one.
    if (ipHash && isRateLimited(await countRecentMessagesFrom(backend, ipHash, rateLimitSince(new Date())))) {
      return { status: "error", errors: {}, formError: CONTACT_COPY.rateLimited, values: fields };
    }
    const { topic, name, email, message } = validated.value;
    await saveContactMessage(backend, { topic, name: name || null, email, message, ipHash });
  } catch (err) {
    /* Nothing pushes a notification: /admin has to be looked at. An email
       hook belongs here, after the row is safely stored, so a mail outage
       cannot swallow the message. Better to admit a failure than lose a
       message quietly. */
    console.error("[contact] could not store message", err);
    return { status: "error", errors: {}, formError: CONTACT_COPY.unavailable, values: fields };
  }

  return { status: "sent", errors: {}, values: EMPTY_CONTACT_FIELDS };
}
