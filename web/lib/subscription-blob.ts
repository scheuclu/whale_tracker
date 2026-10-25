import { BlobPreconditionFailedError, del, get, list, put } from "@vercel/blob";
import { alertsSecret } from "./subscription-token";
import type { ListedSubscriptionBlob, SubscriptionBlobBackend } from "./subscription-store";

type Env = Record<string, string | undefined>;

export function blobStoreConfigured(env: Env = process.env): boolean {
  return Boolean(env.BLOB_STORE_ID?.trim() || env.BLOB_READ_WRITE_TOKEN?.trim());
}

export function subscriptionsConfigured(env: Env = process.env): boolean {
  return blobStoreConfigured(env) && alertsSecret(env) !== null;
}

const ACCESS = "private" as const;

export const vercelSubscriptionBackend: SubscriptionBlobBackend = {
  async list(prefix) {
    const out: ListedSubscriptionBlob[] = [];
    let cursor: string | undefined;
    do {
      const page = await list({ prefix, cursor, limit: 1000 });
      for (const b of page.blobs) out.push({ pathname: b.pathname, url: b.url });
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return out;
  },

  async read(blob) {
    const res = await get(blob.url, { access: ACCESS, useCache: false });
    if (!res || res.statusCode !== 200) return null;
    return { body: await new Response(res.stream).text(), etag: res.blob.etag };
  },

  async readByPath(pathname) {
    const res = await get(pathname, { access: ACCESS, useCache: false });
    if (!res || res.statusCode !== 200) return null;
    return { body: await new Response(res.stream).text(), etag: res.blob.etag };
  },

  async write(pathname, body, ifMatch) {
    try {
      await put(pathname, body, {
        access: ACCESS,
        contentType: "application/json",
        addRandomSuffix: false,
        allowOverwrite: true,
        ...(ifMatch ? { ifMatch } : {}),
      });
      return "ok";
    } catch (err) {
      if (err instanceof BlobPreconditionFailedError) return "conflict";
      throw err;
    }
  },

  async del(pathname) {
    try {
      await del(pathname);
    } catch {
      /* already absent */
    }
  },
};

export function subscriptionBackend(env: Env = process.env): SubscriptionBlobBackend | null {
  return blobStoreConfigured(env) ? vercelSubscriptionBackend : null;
}
