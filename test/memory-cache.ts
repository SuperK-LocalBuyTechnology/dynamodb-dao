import { CacheAdapter } from "../src";

export type MemoryCache = CacheAdapter & { store: Map<string, unknown> };

export function memoryCache(): MemoryCache {
    const store = new Map<string, unknown>();
    return {
        store,
        get: <T>(key: string) => store.get(key) as T | undefined,
        set: <T>(key: string, value: T) => {
            store.set(key, value);
        },
        del: (key: string) => {
            store.delete(key);
        },
    };
}
