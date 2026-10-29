import { attribute, hashKey, table, versionAttribute } from "@nova-odm/annotations";
import { ExpressionAttributes, UpdateExpression } from "@nova-odm/expressions";
import { getSchema } from "@nova-odm/mapper";
import { marshallUpdateExpression, ZeroArgumentsConstructor } from "@nova-odm/marshaller";
import { BaseDAO, BaseModel, configureDao, mapper } from "../src";
import { memoryCache } from "./memory-cache";

@table("Orders")
class Order extends BaseModel {
    @hashKey({ type: "String" })
    id?: string;

    @attribute({ type: "Number" })
    count?: number;
}

@table("VersionedOrders")
class VersionedOrder extends Order {
    @versionAttribute()
    version?: number;
}

@table("RenamedOrders")
class RenamedOrder extends BaseModel {
    @hashKey({ type: "String" })
    id?: string;

    @attribute({ type: "Number", attributeName: "cnt" })
    count?: number;
}

class OrderDAO extends BaseDAO<Order> {
    constructor() {
        super("id");
    }
}

class VersionedOrderDAO extends BaseDAO<VersionedOrder> {
    constructor() {
        super("id");
    }
}

class RenamedOrderDAO extends BaseDAO<RenamedOrder> {
    constructor() {
        super("id");
    }
}

// The update as DynamoDB receives it, placeholders resolved, e.g. `SET count = if_not_exists(count, {"N":"0"}) + {"N":"3"}`.
function render(expression: UpdateExpression, valueConstructor: ZeroArgumentsConstructor<any>): string {
    const attributes = new ExpressionAttributes();
    let text = marshallUpdateExpression(expression, getSchema(valueConstructor.prototype), attributes).expression;
    const tokens: [string, string][] = [
        ...Object.entries(attributes.names),
        ...Object.entries(attributes.values).map(([token, value]): [string, string] => [token, JSON.stringify(value)]),
    ];
    // Longest first, so ":val1" never rewrites part of ":val10".
    for (const [token, value] of tokens.sort(([first], [second]) => second.length - first.length)) {
        text = text.split(token).join(value);
    }
    return text;
}

const spyOnExpressionUpdate = () =>
    jest
        .spyOn(mapper, "executeUpdateExpression")
        .mockImplementation(async (_expression: any, key: any, valueConstructor: any) =>
            Object.assign(new valueConstructor(), key)
        );

afterEach(() => {
    jest.restoreAllMocks();
    configureDao({ cache: undefined });
});

describe("BaseDAO.updateNumericAttributeBy", () => {
    it("adds a positive delta, starting from 0 when the attribute is unset", async () => {
        const executeSpy = spyOnExpressionUpdate();

        await new OrderDAO().updateNumericAttributeBy(Order, { id: "o-1" }, "count", 3);

        const [expression, key, valueConstructor] = executeSpy.mock.calls[0];
        const text = render(expression, Order);
        expect(text).toContain('count = if_not_exists(count, {"N":"0"}) + {"N":"3"}');
        expect(text).toContain("modifiedAt = ");
        expect(key).toEqual({ id: "o-1" });
        expect(valueConstructor).toBe(Order);
    });

    it("subtracts a negative delta", async () => {
        const executeSpy = spyOnExpressionUpdate();

        await new OrderDAO().updateNumericAttributeBy(Order, { id: "o-1" }, "count", -2);

        expect(render(executeSpy.mock.calls[0][0], Order)).toContain(
            'count = if_not_exists(count, {"N":"0"}) - {"N":"2"}'
        );
    });

    it("reads and writes the stored name when the model renames the attribute", async () => {
        const executeSpy = spyOnExpressionUpdate();

        await new RenamedOrderDAO().updateNumericAttributeBy(RenamedOrder, { id: "o-1" }, "count", 3);

        expect(render(executeSpy.mock.calls[0][0], RenamedOrder)).toContain(
            'cnt = if_not_exists(cnt, {"N":"0"}) + {"N":"3"}'
        );
    });

    it("bumps the version of a versioned model, so copies read before the update fail their version check", async () => {
        const executeSpy = spyOnExpressionUpdate();

        await new VersionedOrderDAO().updateNumericAttributeBy(VersionedOrder, { id: "o-1" }, "count", 3);

        expect(render(executeSpy.mock.calls[0][0], VersionedOrder)).toContain(
            'version = if_not_exists(version, {"N":"0"}) + {"N":"1"}'
        );
    });

    it("refuses to update the version attribute itself by a delta, without writing", async () => {
        const executeSpy = spyOnExpressionUpdate();

        await expect(
            new VersionedOrderDAO().updateNumericAttributeBy(VersionedOrder, { id: "o-1" }, "version", 1)
        ).rejects.toThrow("Cannot update version by a delta");
        expect(executeSpy).not.toHaveBeenCalled();
    });

    it("drops the cached item", async () => {
        const cache = memoryCache();
        configureDao({ cache });
        cache.store.set("order_o-1", Object.assign(new Order(), { id: "o-1", count: 1 }));
        spyOnExpressionUpdate();

        await new OrderDAO().updateNumericAttributeBy(Order, { id: "o-1" }, "count", 3);

        expect(cache.store.has("order_o-1")).toBe(false);
    });
});
