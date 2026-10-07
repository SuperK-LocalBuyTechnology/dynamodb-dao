import { DynamoDB } from "@aws-sdk/client-dynamodb";
import {
    AttributePath,
    ConditionExpression,
    ConditionExpressionPredicate,
    FunctionExpression,
    MathematicalExpression,
    UpdateExpression,
} from "@nova-odm/expressions";
import {
    DataMapper,
    ParallelScanOptions,
    ParallelScanWorkerOptions,
    PutOptions,
    QueryOptions,
    ReadConsistency,
    ScanOptions,
} from "@nova-odm/mapper";
import { ZeroArgumentsConstructor } from "@nova-odm/marshaller";
import { v4 as uuidv4 } from "uuid";
import { BaseModel } from "./base-model";
import { CacheAdapter } from "./cache-adapter";
import { DaoError } from "./dao-error";

/** Default DynamoDB client. Replace it with `configureDao({ client })`. */
export const client = new DynamoDB({
    maxAttempts: 10,
}) as any;
export const mapper = new DataMapper({ client });

export interface DaoConfig {
    /** Cache used by `fromCache` / `storeInCache`. Without one, those flags are no-ops. */
    cache?: CacheAdapter;
    /** Your own DynamoDB client (custom region, endpoint, credentials, retries). Applied to the shared `mapper`. */
    client?: DynamoDB;
    /** When true, `storeInCache` without a `hashKeyName` in the DAO constructor throws instead of being ignored. */
    strictCacheKeyCheck?: boolean;
}

const daoConfig: { cache?: CacheAdapter; strictCacheKeyCheck: boolean } = { strictCacheKeyCheck: false };

/**
 * Configures every BaseDAO in the process. Call it once at startup, before the first DAO call.
 * Only the options you pass are changed.
 */
export function configureDao(config: DaoConfig): void {
    if ("cache" in config) {
        daoConfig.cache = config.cache;
    }
    if (config.strictCacheKeyCheck !== undefined) {
        daoConfig.strictCacheKeyCheck = config.strictCacheKeyCheck;
    }
    if (config.client) {
        // DataMapper keeps its client in a private field; swap it so existing `mapper` references keep working.
        (mapper as unknown as { client: DynamoDB }).client = config.client;
    }
}

function delay(seconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

export type RecursivePartial<T> = {
    [P in keyof T]?: RecursivePartial<T[P]>;
};

export type PartialExcept<T, K extends keyof T> = RecursivePartial<T> & Pick<T, K>;

// DynamoDB errors that will never succeed on retry (bad request/item shape, missing resource, etc.)
// as opposed to transient errors (throttling, timeouts) that the SDK's own maxAttempts backoff already handles.
const NON_RETRYABLE_DDB_ERROR_NAMES = new Set([
    "ValidationException",
    "ItemCollectionSizeLimitExceededException",
    "ResourceNotFoundException",
    "AccessDeniedException",
    "SerializationException",
]);

function isRetryableBatchPutError(error: unknown): boolean {
    const name = (error as { name?: string })?.name;
    return !name || !NON_RETRYABLE_DDB_ERROR_NAMES.has(name);
}

export class BaseDAO<T extends BaseModel, K extends keyof T = any, R extends keyof T = any> {
    protected daoName: string;
    protected hashKeyName?: K;
    protected rangeKeyName?: R;

    constructor(hashKeyName?: K, rangeKeyName?: R) {
        this.daoName = this.constructor.name.replace(/DAO$/, "").toLowerCase();
        this.hashKeyName = hashKeyName;
        this.rangeKeyName = rangeKeyName;
    }

    /**
     * Handles cache operations (set or delete) for an item
     * Also validates if caching can be performed based on hash key availability
     * @param item The item to cache or remove from cache
     * @param storeInCache Whether to store the item in cache or just invalidate
     * @param cacheTtl Cache time-to-live in seconds
     * @returns The potentially modified storeInCache value
     */
    private handleCacheOperation(item: T, storeInCache: boolean = false, cacheTtl: number = 3600): boolean {
        // First validate if caching can be performed based on hash key availability
        if (storeInCache && !this.hashKeyName) {
            if (daoConfig.strictCacheKeyCheck) {
                throw new Error("hashKeyName must be provided in constructor when storeInCache is set to true");
            }
            return false; // prod fallback for storeInCache
        }

        // Skip actual cache operations if no hash key is available
        if (!this.hashKeyName) {
            return storeInCache;
        }

        const cacheKey = this.buildCacheKey(item);
        if (cacheKey) {
            if (storeInCache) {
                daoConfig.cache?.set(cacheKey, item, cacheTtl);
            } else {
                daoConfig.cache?.del(cacheKey);
            }
        }

        return storeInCache;
    }

    /**
     * Retrieves an item from cache if it exists
     * @param item The item containing key values to look up in cache
     * @returns The cached item if found, null otherwise
     */
    private getFromCache(item: T): T | undefined {
        if (!this.hashKeyName) {
            return undefined;
        }

        const cacheKey = this.buildCacheKey(item);
        if (!cacheKey) {
            return undefined;
        }

        const cachedItem = daoConfig.cache?.get<T>(cacheKey);
        return cachedItem;
    }

    /**
     * Retrieves multiple items from cache
     * @param items Array of items to look up in cache
     * @returns Object containing items found in cache and items not found
     */
    private getItemsFromCache(items: T[]): { cachedItems: T[]; itemsToFetch: T[] } {
        const cachedItems: T[] = [];
        const itemsToFetch: T[] = [];

        for (const item of items) {
            const cachedItem = this.getFromCache(item);
            if (cachedItem) {
                cachedItems.push(cachedItem);
            } else {
                itemsToFetch.push(item);
            }
        }

        return { cachedItems, itemsToFetch };
    }

    /**
     * Builds a cache key from class-level hash key and optional range key
     * @param item The item containing the key values
     * @returns The constructed cache key
     */
    private buildCacheKey(item: T): string | null {
        if (!this.hashKeyName || !item[this.hashKeyName]) return null;

        // Use the daoName as prefix
        let cacheKey = `${this.daoName}_${String(item[this.hashKeyName])}`;
        if (this.rangeKeyName && item[this.rangeKeyName]) {
            cacheKey += `_${String(item[this.rangeKeyName])}`;
        }

        return cacheKey;
    }

    deepMerge<T>(existingModel: T, updateItem: T): T {
        for (const key in updateItem) {
            const existingValue = existingModel[key];
            const updateValue = updateItem[key];
            if (updateValue == null) {
                continue;
            }
            if (this.isObject(existingValue) && this.isObject(updateValue)) {
                existingModel[key] = this.deepMerge(existingValue, updateValue);
            } else {
                existingModel[key] = updateValue;
            }
        }
        return existingModel;
    }

    isObject(value: unknown): boolean {
        return value != undefined && typeof value === "object" && !Array.isArray(value);
    }

    private flattenObject(input: any, parentKey: string = "") {
        const flattenObjectResult: { [key: string]: unknown } = {};
        for (const key in input) {
            if (Object.prototype.hasOwnProperty.call(input, key)) {
                const currentKey = parentKey ? `${parentKey}.${key}` : key;
                const value = input[key];

                if (Array.isArray(value)) {
                    flattenObjectResult[currentKey] = value;
                } else if (typeof value === "object" && value != null) {
                    Object.assign(flattenObjectResult, this.flattenObject(value, currentKey));
                } else {
                    flattenObjectResult[currentKey] = value;
                }
            }
        }
        console.log(`return statement ${JSON.stringify(flattenObjectResult)}`);
        return flattenObjectResult;
    }

    static generateUUID(): string {
        return uuidv4();
    }
    generateCustomId(): string {
        const epoch = new Date().getTime();
        const radomNumeric = Math.floor(1000 + Math.random() * 9000);
        return `${epoch}${radomNumeric}`;
    }

    async batchPut(
        items: T[],
        updateModified: boolean = true,
        storeInCache: boolean = false,
        cacheTtl: number = 3600
    ): Promise<T[]> {
        const finalItems: T[] = [];
        if (updateModified) {
            items = items.map((item) => {
                item.modifiedAt = new Date();
                return item;
            });
        }

        for await (const item of mapper.batchPut(items)) {
            finalItems.push(item);

            storeInCache = this.handleCacheOperation(item, storeInCache, cacheTtl);
        }

        return finalItems;
    }

    async batchUpdate(
        items: T[],
        batchSize = 100,
        storeInCache: boolean = false,
        cacheTtl: number = 3600
    ): Promise<T[]> {
        let success = 0;
        const totalToUpdate = items.length;
        const updateItems: T[] = [];
        const totalLoops = Math.ceil(items.length / batchSize);
        let loopCount = 0;

        while (items.length > 0 && loopCount < totalLoops + 10) {
            let promises = [];
            const batch = items.splice(0, batchSize);
            promises = batch.map((item) => this.update(item));
            const results = await Promise.allSettled(promises);
            loopCount += 1;

            results.forEach((result, index) => {
                if (result.status === "fulfilled") {
                    success += 1;
                    const updatedItem = result.value;
                    updateItems.push(updatedItem);
                    this.handleCacheOperation(updatedItem, storeInCache, cacheTtl);
                } else {
                    console.log(`BatchUpdateFailure: Failed to update item at index ${index}: ${result.reason}`);
                    items.push(batch[index]);
                }
            });

            console.log(`${success}/${totalToUpdate}`);
        }

        if (loopCount > totalLoops + 5) {
            console.log(
                `BatchUpdateFailure: Failed to do batch update ${totalToUpdate - success}/${totalToUpdate} items`
            );
        }

        return updateItems;
    }

    /**
     * Add items to DDB in parallel.
     *
     * @param inputItems Input items to be added to DDB.
     * @param batchSize Batch size for each segment.
     * @param maxConcurrentSegments Maximum number of concurrent segments.
     * @param updateModified Whether to update modifiedAt field.
     * @param storeInCache Whether to store in cache.
     * @param cacheTtl Cache time to live in seconds.
     * @param minSegmentIntervalSeconds Minimum wall-clock time to spend per segment. When all items in a
     * segment share a hash key (and therefore a single DynamoDB partition), raising batchSize/maxConcurrentSegments
     * doesn't raise the partition's throughput ceiling — it only changes how fast the client tries to exceed it.
     * This paces sustained throughput to that ceiling instead. Defaults to 0 (no pacing, existing behavior).
     * @returns DDB response items if the input items length is less than 100K. Otherwise it returns empty array.
     */
    async parallelBatchPut(
        inputItems: T[],
        batchSize: number = 1000,
        maxConcurrentSegments: number = 20,
        updateModified: boolean = true,
        storeInCache: boolean = false,
        cacheTtl: number = 3600,
        minSegmentIntervalSeconds: number = 0
    ): Promise<T[]> {
        const inputItemsLength = inputItems.length;
        const startTime = Date.now();
        let items: T[] = [];
        items = items.concat(inputItems);
        inputItems = [];
        if (updateModified) {
            items = items.map((item) => {
                item.modifiedAt = new Date();
                return item;
            });
        }
        const maxSegments: T[][][] = [];
        let putItems: T[] = [];
        while (items.length > 0) {
            const batch = items.splice(0, batchSize * maxConcurrentSegments);
            const segment: T[][] = [];
            while (batch.length > 0) {
                segment.push(batch.splice(0, batchSize));
            }
            maxSegments.push(segment);
        }
        const maxSegmentsLength = maxSegments.length;
        let failures = 0;
        let segmentIndex = 0;
        while (segmentIndex < maxSegments.length) {
            const segment = maxSegments[segmentIndex];
            segmentIndex += 1;
            const segmentStartedAt = Date.now();
            const promises: Promise<T[]>[] = [];
            for (const batch of segment) {
                promises.push(this.batchPut(batch, updateModified));
            }
            const result = await Promise.allSettled(promises);
            const failedSegments: T[][] = [];
            result.forEach((res, index) => {
                if (res.status == "fulfilled") {
                    const response = res.value;
                    if (inputItemsLength < 100000) {
                        putItems = putItems.concat(response);
                    }

                    response.forEach((item) => {
                        storeInCache = this.handleCacheOperation(item, storeInCache, cacheTtl);
                    });
                } else if (isRetryableBatchPutError(res.reason)) {
                    failedSegments.push(segment[index]);
                } else {
                    const error = res.reason as { name?: string; message?: string };
                    console.log(
                        `ParallelBatchPutFailure: non-retryable ${error?.name} for ${segment[index].length} item(s): ${error?.message}`
                    );
                    throw res.reason;
                }
            });
            let delaySeconds = 0;
            if (failedSegments.length > 0) {
                console.log(`There are failed items ${maxSegmentsLength} ${maxSegments.length}`);
                if (maxSegments.length >= maxSegmentsLength + 10) {
                    throw new Error(
                        `ParallelBatchPutFailure: gave up after 10 retries with ${failedSegments.length} batch(es) still failing`
                    );
                }
                maxSegments.push(failedSegments);
                delaySeconds = Math.min(2 ** failures, 60);
                failures += 1;
            }
            if (minSegmentIntervalSeconds > 0 && segmentIndex < maxSegments.length) {
                const elapsedSeconds = (Date.now() - segmentStartedAt) / 1000;
                delaySeconds = Math.max(delaySeconds, minSegmentIntervalSeconds - elapsedSeconds);
            }
            if (delaySeconds > 0) {
                await delay(delaySeconds);
            }
        }
        console.log(`total time for complete parallel put ${Date.now() - startTime}`);
        return putItems;
    }

    async parallelBatchDelete(
        inputItems: T[],
        batchSize: number = 1000,
        maxConcurrentSegments: number = 20
    ): Promise<T[]> {
        const startTime = Date.now();
        let items: T[] = [];
        items = items.concat(inputItems);
        const maxSegments: T[][][] = [];
        let putItems: T[] = [];
        while (items.length > 0) {
            const batch = items.splice(0, batchSize * maxConcurrentSegments);
            const segment: T[][] = [];
            while (batch.length > 0) {
                segment.push(batch.splice(0, batchSize));
            }
            maxSegments.push(segment);
        }
        for (const segment of maxSegments) {
            const promises: Promise<T[]>[] = [];
            for (const batch of segment) {
                promises.push(this.batchDelete(batch));
            }
            const result = await Promise.all(promises);
            result.forEach((res) => {
                putItems = putItems.concat(res);

                res.forEach((item) => {
                    this.handleCacheOperation(item, false);
                });
            });
        }
        console.log(`total time for complete parallel delete ${Date.now() - startTime}`);
        return putItems;
    }

    /**
     * This function has to be used only in the scripts.
     *
     * @param valueConstructor the model class
     * @param options scan options
     * @param storeInCache whether to store items in cache
     * @param cacheTtl cache time-to-live in seconds
     */
    async parallelScan(
        valueConstructor: ZeroArgumentsConstructor<T>,
        options?: ParallelScanOptions,
        storeInCache: boolean = false,
        cacheTtl: number = 3600
    ): Promise<T[]> {
        const items: T[] = [];
        for await (const item of mapper.parallelScan(valueConstructor, 4, options)) {
            items.push(item);

            if (storeInCache) {
                storeInCache = this.handleCacheOperation(item, storeInCache, cacheTtl);
            }

            if (items.length % 100000 == 0) {
                console.log("read 100K");
            }
        }
        return items;
    }

    async scan(
        valueConstructor: ZeroArgumentsConstructor<T>,
        options?: ScanOptions | ParallelScanWorkerOptions,
        storeInCache: boolean = false,
        cacheTtl: number = 3600
    ): Promise<T[]> {
        const items: T[] = [];
        for await (const item of mapper.scan(valueConstructor, options)) {
            items.push(item);

            if (storeInCache) {
                storeInCache = this.handleCacheOperation(item, storeInCache, cacheTtl);
            }
        }
        return items;
    }

    async save(item: T, storeInCache: boolean = false, cacheTtl: number = 3600): Promise<T> {
        item.modifiedAt = undefined;
        const res = await mapper.put(item);

        this.handleCacheOperation(res, storeInCache, cacheTtl);

        return res;
    }

    async conditionalSave(
        item: T,
        options?: PutOptions,
        storeInCache: boolean = false,
        cacheTtl: number = 3600
    ): Promise<T> {
        item.modifiedAt = undefined;
        const res = await mapper.put(item, options);

        this.handleCacheOperation(res, storeInCache, cacheTtl);

        return res;
    }

    async update(
        item: T,
        storeInCache: boolean = false,
        cacheTtl: number = 3600,
        condition?: ConditionExpression
    ): Promise<T> {
        item.modifiedAt = new Date();
        const res = await mapper.update(item, {
            onMissing: "skip",
            condition,
        });

        if (this.hashKeyName) {
            this.handleCacheOperation(res, storeInCache, cacheTtl);
        }

        return res;
    }

    /**
     * Persists a loaded item while REMOVING any attributes that are now unset (onMissing: "remove"), then
     * invalidates its cache. Use to clear a sparse-index marker: pass the marker name(s) in `attributeNames`
     * and the item drops out of that GSI. Any other attributes set on `item` are written normally, so a
     * combined "set some / clear some" update stays a single atomic UpdateItem. The cache is always
     * invalidated (never repopulated) — the stored item just changed shape, so the next read re-fetches it.
     */
    async clearSparseAttributes(item: T, attributeNames: (keyof T)[] = []): Promise<T> {
        for (const name of attributeNames) {
            item[name] = undefined as T[typeof name];
        }
        item.modifiedAt = new Date();
        const res = await mapper.update(item, {
            onMissing: "remove",
        });

        if (this.hashKeyName) {
            this.handleCacheOperation(res, false);
        }

        return res;
    }
    async delete(item: T): Promise<T | undefined> {
        // For delete operations, we always want to invalidate the cache if possible
        const res = await mapper.delete(item, { returnValues: "ALL_OLD" });

        // Invalidate cache using class-level hash and range keys
        this.handleCacheOperation(item, false);

        return res;
    }

    async get(
        item: T,
        readConsistency: ReadConsistency = "eventual",
        fromCache: boolean = false,
        cacheTtl: number = 3600,
        storeInCache: boolean = false
    ): Promise<T> {
        if (fromCache) {
            const cachedItem = this.getFromCache(item);
            if (cachedItem) {
                return cachedItem;
            }
        }

        const res = await mapper.get(item, {
            readConsistency: readConsistency,
        });

        this.handleCacheOperation(res, storeInCache, cacheTtl);

        return res;
    }

    async updateUsingUpdateExpression(
        valueConstructor: ZeroArgumentsConstructor<T>,
        primaryKey: { [propertyName: string]: any },
        updateItem: RecursivePartial<T>,
        storeInCache: boolean = false,
        cacheTtl: number = 3600,
        removePaths: string[] = []
    ): Promise<T> {
        const flattenObject = this.flattenObject(updateItem);
        const updateExpression: UpdateExpression = new UpdateExpression();
        for (const [path, value] of Object.entries(flattenObject)) {
            updateExpression.set(path, value);
        }
        updateExpression.set("modifiedAt", parseFloat((Date.now() / 1000).toFixed(0)));

        for (const path of removePaths) {
            updateExpression.remove(path);
        }

        const res = await mapper.executeUpdateExpression(updateExpression, primaryKey, valueConstructor);

        this.handleCacheOperation(res, storeInCache, cacheTtl);

        return res;
    }

    async batchDelete(items: T[]): Promise<T[]> {
        const finalItems: T[] = [];
        for await (const item of mapper.batchDelete(items)) {
            finalItems.push(item);

            this.handleCacheOperation(item, false);
        }
        return finalItems;
    }

    async getAndUpdate(
        item: T,
        validationFunction?: (item: T) => DaoError | T,
        fromCache: boolean = true,
        storeInCache: boolean = false,
        cacheTtl: number = 3600
    ): Promise<T | DaoError> {
        // Get the existing item, optionally from cache
        const existingModel = await this.get(item, "eventual", fromCache, cacheTtl, false);
        const deepMergeModel = this.deepMerge(existingModel, item);

        if (validationFunction) {
            const validation = validationFunction(deepMergeModel);
            if (DaoError.isDaoError(validation)) {
                return new DaoError(400, `Validation Failed ${JSON.stringify(validation)}`);
            }
        }

        const updatedItem = await this.update(deepMergeModel, false);
        this.handleCacheOperation(updatedItem, storeInCache, cacheTtl);

        return updatedItem;
    }

    async batchGet<K extends keyof T = any>(
        items: T[],
        readConsistency: ReadConsistency = "eventual",
        fromCache: boolean = false,
        hashKeyName?: K,
        cacheTtl: number = 3600,
        storeInCache: boolean = false
    ): Promise<T[]> {
        let getItems: T[] = [];
        let itemsToFetch: T[] = [];

        if (fromCache) {
            const cacheResult = this.getItemsFromCache(items);
            getItems = cacheResult.cachedItems;
            itemsToFetch = cacheResult.itemsToFetch;
        } else {
            itemsToFetch = [...items];
        }
        if (itemsToFetch.length > 0) {
            const keysSet = new Set<string>();
            itemsToFetch = itemsToFetch.filter((item) => {
                const key = this.buildCacheKey(item);
                if (key != null && keysSet.has(key)) {
                    return false;
                }
                keysSet.add(key ?? "");
                return true;
            });
            for await (const item of mapper.batchGet(itemsToFetch, {
                readConsistency: readConsistency,
            })) {
                storeInCache = this.handleCacheOperation(item, storeInCache, cacheTtl);
                getItems.push(item);
            }
        }

        return getItems;
    }

    async parallelBatchGet(
        inputItems: T[],
        readConsistency?: ReadConsistency,
        batchSize: number = 1000,
        maxConcurrentSegments: number = 20,
        fromCache: boolean = false,
        storeInCache: boolean = false,
        cacheTtl: number = 3600
    ): Promise<T[]> {
        const startTime = Date.now();
        let items: T[] = [];
        items = items.concat(inputItems);
        const maxSegments: T[][][] = [];
        let resultItems: T[] = [];
        while (items.length > 0) {
            const batch = items.splice(0, batchSize * maxConcurrentSegments);
            const segment: T[][] = [];
            while (batch.length > 0) {
                segment.push(batch.splice(0, batchSize));
            }
            maxSegments.push(segment);
        }
        for (const segment of maxSegments) {
            const promises: Promise<T[]>[] = [];
            for (const batch of segment) {
                promises.push(this.batchGet(batch, readConsistency, fromCache, undefined, cacheTtl, storeInCache));
            }
            const result = await Promise.all(promises);
            result.forEach((res) => {
                resultItems = resultItems.concat(res);
            });
        }
        console.debug(`total time for complete parallel get ${Date.now() - startTime}`);
        return resultItems;
    }
    async parallelQuery(
        valueConstructor: ZeroArgumentsConstructor<T>,
        keyConditions: Array<ConditionExpression | { [propertyName: string]: ConditionExpressionPredicate | any }>,
        options?: QueryOptions,
        maxConcurrentCalls: number = 20,
        storeInCache: boolean = false,
        cacheTtl: number = 3600
    ): Promise<T[]> {
        const startTime = Date.now();
        const results: T[] = [];
        while (keyConditions.length > 0) {
            const segmentConditions = keyConditions.splice(0, maxConcurrentCalls);
            const queryPromises = segmentConditions.map((keyCondition) => {
                return this.customQuery(valueConstructor, keyCondition, options, storeInCache, cacheTtl);
            });
            const queryResults = await Promise.all(queryPromises);

            for (const queryResult of queryResults) {
                results.push(...queryResult);
            }
        }
        console.debug(`total time for complete parallel query ${Date.now() - startTime}`);
        return results;
    }
    async customQuery(
        valueConstructor: ZeroArgumentsConstructor<T>,
        keyConditions: ConditionExpression | { [propertyName: string]: ConditionExpressionPredicate | any },
        options?: QueryOptions,
        storeInCache: boolean = false,
        cacheTtl: number = 3600
    ): Promise<T[]> {
        const startTime = Date.now();
        const items: T[] = [];

        for await (const item of mapper.query(valueConstructor, keyConditions, options)) {
            items.push(item);

            storeInCache = this.handleCacheOperation(item, storeInCache, cacheTtl);
            if (items.length % 100 === 0) {
                console.debug(`read ${items.length} items for current query`);
            }
        }
        console.debug(`total time for complete query ${Date.now() - startTime}`);

        return items;
    }
    async paginationQuery(
        valueConstructor: ZeroArgumentsConstructor<T>,
        keyConditions: ConditionExpression | { [propertyName: string]: ConditionExpressionPredicate | any },
        options?: QueryOptions,
        startKey?: string,
        storeInCache: boolean = false,
        cacheTtl: number = 3600
    ): Promise<{
        items: T[];
        continuationToken: string | null;
    }> {
        const startTime = Date.now();
        const items: T[] = [];
        const exclusiveStartKey = await this.decode(startKey);
        const results = mapper.query(valueConstructor, keyConditions, { ...options, startKey: exclusiveStartKey });
        for await (const item of results) {
            items.push(item);

            storeInCache = this.handleCacheOperation(item, storeInCache, cacheTtl);
        }
        const lastEvaluatedKey = results.pages().lastEvaluatedKey;

        console.log(`total time for pagination query ${Date.now() - startTime}`);
        return {
            items: items,
            continuationToken: lastEvaluatedKey ? await this.encode(lastEvaluatedKey) : null,
        };
    }
    async paginatedScan(
        valueConstructor: ZeroArgumentsConstructor<T>,
        limit: number = 100,
        filter?: ConditionExpression,
        startKey?: string, // Optional startKey for pagination
        storeInCache: boolean = false,
        cacheTtl: number = 3600
    ): Promise<{
        items: T[];
        continuationToken: string | null;
    }> {
        const items: T[] = [];

        const exclusiveStartKey = startKey ? await this.decode(startKey) : undefined;

        const scanOptions: ScanOptions = {
            limit,
            filter: filter ? filter : undefined,
            startKey: exclusiveStartKey,
        };

        const results = mapper.scan(valueConstructor, scanOptions);

        for await (const item of results) {
            items.push(item);

            storeInCache = this.handleCacheOperation(item, storeInCache, cacheTtl);
        }

        const lastEvaluatedKey = results.pages().lastEvaluatedKey;

        const continuationToken = lastEvaluatedKey ? await this.encode(lastEvaluatedKey) : null;

        return {
            items: items,
            continuationToken: continuationToken, // Return the continuation token for pagination
        };
    }

    decode(continuationToken: string | undefined) {
        if (continuationToken) {
            try {
                const lastEvaluatedKey = JSON.parse(Buffer.from(continuationToken, "base64").toString("utf8"));
                console.log("Incoming Last Evaluted Key " + lastEvaluatedKey);
                return lastEvaluatedKey;
            } catch (_error) {
                throw new Error("Invalid continuationToken");
            }
        }
        return undefined;
    }

    async encode(lastEvaluatedKey: any): Promise<string> {
        return Buffer.from(JSON.stringify(lastEvaluatedKey)).toString("base64");
    }

    mathExpression(subject: string, operation: "+" | "-", value: number, initialValue: number = 0) {
        return new MathematicalExpression(
            new FunctionExpression("if_not_exists", new AttributePath(subject), initialValue),
            operation,
            value
        );
    }
}
