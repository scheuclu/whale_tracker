import { BlobPreconditionFailedError, get, list, put } from "@vercel/blob";

import { contactIpSalt } from "./contact-ip";
import type { BlobBackend, ListedBlob } from "./contact-store";

/**
 * The contact store on a **private** Vercel Blob store. Server-only.
 *
 * Credentials are the SDK's own resolution: on Vercel, the connected store's
 * `BLOB_STORE_ID` plus the deployment's rotating OIDC token; elsewhere a
 * `BLOB_READ_WRITE_TOKEN`. Every call is `access: "private"`: nothing in the
 * store has a public URL, and the URLs `list` returns stay on the server.
 */

type Env = Record<string, string | undefined>;

/** A store is connected (blank reads as unset: an empty secret arrives as ""). */
export function blobConfigured(env: Env = process.env): boolean {
  return Boolean(env.BLOB_STORE_ID?.trim() || env.BLOB_READ_WRITE_TOKEN?.trim());
}

/**
 * The form is offered only when it can work: a store to write to and a key
 * for the IP hash (without one the rate limit would be skipped or store a
 * reversible hash). Otherwise the page says it is temporarily unavailable
 * rather than accepting a message it would lose.
 */
export function contactConfigured(env: Env = process.env): boolean {
  return blobConfigured(env) && contactIpSalt(env) !== null;
}

const ACCESS = "private" as const;

export const vercelBlobBackend: BlobBackend = {
  async list(prefix) {
    const out: ListedBlob[] = [];
    let cursor: string | undefined;
    do {
      const page = await list({ prefix, cursor, limit: 1000 });
      for (const b of page.blobs) out.push({ pathname: b.pathname, url: b.url });
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return out;
  },

  async read(blob) {
    // useCache: false — a read right after a write must see that write, and a
    // triage edit must start from the current ETag. Read by URL (as listed),
    // which also lets a local emulator (VERCEL_BLOB_API_URL) stand in.
    const res = await get(blob.url, { access: ACCESS, useCache: false });
    if (!res || res.statusCode !== 200) return null;
    return { body: await new Response(res.stream).text(), etag: res.blob.etag };
  },

  async create(pathname, body) {
    await put(pathname, body, {
      access: ACCESS,
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: false,
    });
  },

  async replace(pathname, body, ifMatch) {
    try {
      await put(pathname, body, { access: ACCESS, contentType: "application/json", addRandomSuffix: false, allowOverwrite: true, ifMatch });
      return "ok";
    } catch (err) {
      if (err instanceof BlobPreconditionFailedError) return "conflict";
      throw err;
    }
  },
};

/** The backend, or null when no store is connected. */
export function contactBackend(): BlobBackend | null {
  return blobConfigured() ? vercelBlobBackend : null;
}
