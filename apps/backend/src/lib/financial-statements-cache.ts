interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const statementsCache = new Map<string, CacheEntry<unknown>>();
const statementsInFlight = new Map<string, Promise<unknown>>();

function cleanupExpired(now = Date.now()): void {
  for (const [key, entry] of statementsCache.entries()) {
    if (entry.expiresAt <= now) {
      statementsCache.delete(key);
    }
  }
}

export async function getCachedFinancialStatements<T>(
  key: string,
  ttlMs: number,
  compute: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  cleanupExpired(now);

  const cached = statementsCache.get(key) as CacheEntry<T> | undefined;
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const inFlight = statementsInFlight.get(key) as Promise<T> | undefined;
  if (inFlight) {
    return inFlight;
  }

  const nextPromise = compute()
    .then((value) => {
      statementsCache.set(key, {
        value,
        expiresAt: Date.now() + ttlMs,
      });
      return value;
    })
    .finally(() => {
      statementsInFlight.delete(key);
    });

  statementsInFlight.set(key, nextPromise as Promise<unknown>);
  return nextPromise;
}

export function invalidateFinancialStatementsCache(): void {
  statementsCache.clear();
  statementsInFlight.clear();
}
