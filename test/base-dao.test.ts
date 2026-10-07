import { BaseDAO, BaseModel, CacheAdapter, DaoError, configureDao, mapper } from "../src";

class Widget extends BaseModel {
    id?: string;
    name?: string;
    rangeId?: string;
}

class WidgetDAO extends BaseDAO<Widget> {
    constructor() {
        super("id");
    }
}

class NoKeyWidgetDAO extends BaseDAO<Widget> {}

function memoryCache(): CacheAdapter & { store: Map<string, unknown> } {
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

const widget = (id: string, name = "w") => Object.assign(new Widget(), { id, name });

describe("BaseDAO caching", () => {
    afterEach(() => {
        jest.restoreAllMocks();
        configureDao({ cache: undefined, strictCacheKeyCheck: false });
    });

    it("serves a stored item from cache on the next get", async () => {
        const cache = memoryCache();
        configureDao({ cache });
        const getSpy = jest.spyOn(mapper, "get").mockImplementation(async (item: any) => item);
        const dao = new WidgetDAO();

        await dao.get(widget("1"), "eventual", false, 60, true);
        expect(cache.store.has("widget_1")).toBe(true);

        const cached = await dao.get(widget("1"), "eventual", true);
        expect(cached.id).toBe("1");
        expect(getSpy).toHaveBeenCalledTimes(1);
    });

    it("misses cache and reads DynamoDB when the key is absent", async () => {
        configureDao({ cache: memoryCache() });
        const getSpy = jest.spyOn(mapper, "get").mockImplementation(async (item: any) => item);

        await new WidgetDAO().get(widget("2"), "eventual", true);

        expect(getSpy).toHaveBeenCalledTimes(1);
    });

    it("invalidates the cached item on delete", async () => {
        const cache = memoryCache();
        configureDao({ cache });
        cache.store.set("widget_3", widget("3"));
        jest.spyOn(mapper, "delete").mockResolvedValue(undefined as any);

        await new WidgetDAO().delete(widget("3"));

        expect(cache.store.has("widget_3")).toBe(false);
    });

    it("includes the range key in the cache key", async () => {
        const cache = memoryCache();
        configureDao({ cache });
        jest.spyOn(mapper, "update").mockImplementation(async (item: any) => item);
        class RangedDAO extends BaseDAO<Widget> {
            constructor() {
                super("id", "rangeId");
            }
        }

        await new RangedDAO().update(Object.assign(widget("4"), { rangeId: "r" }), true);

        expect(cache.store.has("ranged_4_r")).toBe(true);
    });

    it("treats fromCache/storeInCache as no-ops when no cache is configured", async () => {
        const getSpy = jest.spyOn(mapper, "get").mockImplementation(async (item: any) => item);
        const dao = new WidgetDAO();

        await dao.get(widget("5"), "eventual", false, 60, true);
        await dao.get(widget("5"), "eventual", true);

        expect(getSpy).toHaveBeenCalledTimes(2);
    });

    it("throws for storeInCache without a hash key only when strictCacheKeyCheck is on", async () => {
        jest.spyOn(mapper, "put").mockImplementation(async (item: any) => item);
        const dao = new NoKeyWidgetDAO();

        await expect(dao.save(widget("6"), true)).resolves.toBeDefined();

        configureDao({ strictCacheKeyCheck: true });
        await expect(dao.save(widget("6"), true)).rejects.toThrow("hashKeyName must be provided");
    });
});

describe("BaseDAO.getAndUpdate", () => {
    afterEach(() => jest.restoreAllMocks());

    it("returns a DaoError(400) and skips the write when validation fails", async () => {
        jest.spyOn(mapper, "get").mockImplementation(async (item: any) => item);
        const updateSpy = jest.spyOn(mapper, "update").mockImplementation(async (item: any) => item);

        const result = await new WidgetDAO().getAndUpdate(widget("7"), () => new DaoError(422, "bad"));

        expect(DaoError.isDaoError(result)).toBe(true);
        expect((result as DaoError).statusCode).toBe(400);
        expect(updateSpy).not.toHaveBeenCalled();
    });

    it("merges and updates when validation passes", async () => {
        jest.spyOn(mapper, "get").mockResolvedValue(widget("8", "old"));
        const updateSpy = jest.spyOn(mapper, "update").mockImplementation(async (item: any) => item);

        const result = await new WidgetDAO().getAndUpdate(widget("8", "new"), (item) => item);

        expect((result as Widget).name).toBe("new");
        expect(updateSpy).toHaveBeenCalledTimes(1);
    });
});

describe("DaoError.isDaoError", () => {
    it("accepts DaoError and any { statusCode, message } object", () => {
        expect(DaoError.isDaoError(new DaoError(500, "x"))).toBe(true);
        expect(DaoError.isDaoError({ statusCode: 404, message: "nope" })).toBe(true);
    });

    it("rejects primitives, null and unrelated objects", () => {
        for (const value of [null, undefined, "s", 1, true, {}, { statusCode: 1 }]) {
            expect(DaoError.isDaoError(value)).toBe(false);
        }
    });
});

describe("configureDao client injection", () => {
    it("swaps the client inside the shared mapper", () => {
        const fake = { send: jest.fn() } as any;
        const original = (mapper as any).client;

        configureDao({ client: fake });
        expect((mapper as any).client).toBe(fake);

        configureDao({ client: original });
    });
});
