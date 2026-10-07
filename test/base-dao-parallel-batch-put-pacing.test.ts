import { BaseDAO, BaseModel, mapper } from "../src";

class FixtureModel extends BaseModel {
    id?: string;
}

// No hashKeyName in the constructor → the cache path is skipped, isolating batching/pacing behaviour.
class FixtureDAO extends BaseDAO<FixtureModel> {}

const fixtureDao = new FixtureDAO();

// BaseDAO's delay() is a setTimeout wrapper; resolve it immediately and record the requested seconds.
function mockDelay() {
    const seconds: number[] = [];
    jest.spyOn(global, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
        seconds.push((ms ?? 0) / 1000);
        fn();
        return 0;
    }) as any);
    return seconds;
}

function mockBatchPutEchoingInput() {
    return jest.spyOn(mapper, "batchPut").mockImplementation(async function* (items: any) {
        for (const item of items) {
            yield item;
        }
    } as any);
}

describe("BaseDAO.parallelBatchPut pacing", () => {
    afterEach(() => jest.restoreAllMocks());

    it("does not delay between segments when minSegmentIntervalSeconds is left at its default", async () => {
        mockBatchPutEchoingInput();
        const delays = mockDelay();
        const items = [1, 2, 3, 4].map((n) => Object.assign(new FixtureModel(), { id: String(n) }));

        // batchSize=1, maxConcurrentSegments=1 → 4 segments, so pacing (if any) would show up as inter-segment delays.
        await fixtureDao.parallelBatchPut(items, 1, 1, false);

        expect(delays).toHaveLength(0);
    });

    it("delays between segments to enforce minSegmentIntervalSeconds, but not after the final segment", async () => {
        mockBatchPutEchoingInput();
        const delays = mockDelay();
        const items = [1, 2, 3, 4].map((n) => Object.assign(new FixtureModel(), { id: String(n) }));

        // 4 items, batchSize=1, maxConcurrentSegments=1 → 4 segments → 3 inter-segment gaps expected.
        await fixtureDao.parallelBatchPut(items, 1, 1, false, false, 3600, 0.05);

        expect(delays).toHaveLength(3);
        for (const seconds of delays) {
            expect(seconds).toBeGreaterThan(0);
            expect(seconds).toBeLessThanOrEqual(0.05);
        }
    });

    it("paces using the larger of the retry backoff and the pacing interval when a segment fails", async () => {
        const batchPutSpy = jest
            .spyOn(mapper, "batchPut")
            .mockImplementationOnce(
                () =>
                    ({
                        [Symbol.asyncIterator]: () => ({
                            next: () =>
                                Promise.reject(Object.assign(new Error("throttled"), { name: "ThrottlingException" })),
                        }),
                    }) as any
            )
            .mockImplementation(async function* (items: any) {
                for (const item of items) {
                    yield item;
                }
            } as any);
        const delays = mockDelay();
        const items = [1, 2].map((n) => Object.assign(new FixtureModel(), { id: String(n) }));

        // Single segment (batchSize*maxConcurrentSegments >= items.length) that fails once, then retries and succeeds.
        await fixtureDao.parallelBatchPut(items, 2, 1, false, false, 3600, 30);

        // Retry backoff for the first failure is min(2**0, 60) = 1s, which is less than the 30s pacing floor.
        expect(delays).toHaveLength(1);
        expect(delays[0]).toBeGreaterThan(1);
        expect(delays[0]).toBeLessThanOrEqual(30);
        expect(batchPutSpy).toHaveBeenCalledTimes(2);
    });
});
