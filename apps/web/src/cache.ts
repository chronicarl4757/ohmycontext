// stale-while-revalidate route data cache (~60 lines, no deps)

interface Entry<T> {
  data: T;
  at: number;
}

const cache = new Map<string, Entry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

export function getCached<T>(key: string): T | undefined {
  return cache.get(key)?.data as T | undefined;
}

/** Deduplicated fetch that populates the cache. */
export function fetchCached<T>(key: string, loader: () => Promise<T>): Promise<T> {
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const p = loader()
    .then((data) => {
      cache.set(key, { data, at: Date.now() });
      inflight.delete(key);
      return data;
    })
    .catch((err: unknown) => {
      inflight.delete(key);
      throw err;
    });
  inflight.set(key, p as Promise<unknown>);
  return p;
}

/** Warm the cache without rendering; failures are silent. */
export function prefetch<T>(key: string, loader: () => Promise<T>): void {
  if (cache.has(key) || inflight.has(key)) return;
  void fetchCached(key, loader).catch(() => {});
}

export function cacheSize(): number {
  return cache.size;
}
