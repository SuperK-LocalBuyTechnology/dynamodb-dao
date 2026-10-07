/**
 * Minimal cache contract used by BaseDAO. Any in-memory or external cache can be plugged in
 * through `configureDao({ cache })`. When no cache is configured, `fromCache` / `storeInCache`
 * are no-ops.
 */
export interface CacheAdapter {
    get<T>(key: string): T | undefined;
    set<T>(key: string, value: T, ttlSeconds?: number): void;
    del(key: string): void;
}
