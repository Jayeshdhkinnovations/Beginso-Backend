// A tiny in-process cache with a time limit, for heavy read-only aggregations behind the super admin console. One entry per key; an
// entry older than `ttlMs` is recomputed. Per server instance (not shared): a second instance computes its own copy, which is fine
// for numbers that are allowed to be a minute old. Concurrent requests for the same key share one computation.

interface Entry<T> {
  value: T;
  at: number;
}

const MAX_ENTRIES = 200;
const store = new Map<string, Entry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

export interface Cached<T> {
  value: T;
  /** When the value was computed (ISO). */
  computedAt: string;
  /** True when served from the cache. */
  cached: boolean;
}

export async function cachedFor<T>(key: string, ttlMs: number, compute: () => Promise<T>, bypass = false): Promise<Cached<T>> {
  const now = Date.now();
  const hit = store.get(key) as Entry<T> | undefined;
  if (!bypass && hit && now - hit.at < ttlMs) {
    return { value: hit.value, computedAt: new Date(hit.at).toISOString(), cached: true };
  }

  let pending = inflight.get(key) as Promise<T> | undefined;
  if (!pending) {
    pending = compute().finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  const value = await pending;
  const at = Date.now();
  store.set(key, { value, at });
  if (store.size > MAX_ENTRIES) {
    // Drop the oldest entry (Map keeps insertion order).
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  return { value, computedAt: new Date(at).toISOString(), cached: false };
}

/** For tests. */
export function clearTtlCache(): void {
  store.clear();
  inflight.clear();
}
