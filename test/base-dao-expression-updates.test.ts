import { attribute, hashKey, table } from "@nova-odm/annotations";
import { ConditionExpression, ExpressionAttributes, UpdateExpression } from "@nova-odm/expressions";
import { BaseDAO, BaseModel, mapper } from "../src";

@table("Orders")
class Order extends BaseModel {
    @hashKey({ type: "String" })
    id?: string;

    @attribute({ type: "String" })
    status?: string;

    @attribute({ type: "String" })
    marker?: string;

    @attribute({ type: "Date" })
    closedAt?: Date;

    @attribute({ type: "Number" })
    count?: number;
}

class OrderDAO extends BaseDAO<Order> {
    constructor() {
        super("id");
    }
}

// Renders an update expression with its placeholders resolved, e.g. `SET status = {"S":"CLOSED"} REMOVE marker`.
function render(expression: UpdateExpression): string {
    const attributes = new ExpressionAttributes();
    let text = expression.serialize(attributes);
    const tokens: [string, string][] = [
        ...Object.entries(attributes.names),
        ...Object.entries(attributes.values).map(([token, value]): [string, string] => [token, JSON.stringify(value)]),
    ];
    for (const [token, value] of tokens.sort(([a], [b]) => b.length - a.length)) {
        text = text.split(token).join(value);
    }
    return text;
}

const order = (fields: Partial<Order>) => Object.assign(new Order(), { id: "o-1" }, fields);

const statusIs: ConditionExpression = { type: "Equals", subject: "status", object: "OPEN" };

afterEach(() => jest.restoreAllMocks());

describe("BaseDAO.updateAndRemove", () => {
    it("sets the defined attributes and removes the named ones in one conditional update", async () => {
        const executeSpy = jest
            .spyOn(mapper, "executeUpdateExpression")
            .mockImplementation(async (_expression: any, key: any) => order(key));
        const closedAt = new Date("2026-10-29T10:00:00Z");

        await new OrderDAO().updateAndRemove(order({ status: "CLOSED", closedAt }), ["marker"], statusIs);

        const [expression, key, valueConstructor, options] = executeSpy.mock.calls[0];
        const text = render(expression);
        expect(text).toContain('status = {"S":"CLOSED"}');
        expect(text).toContain(`closedAt = {"N":"${closedAt.getTime() / 1000}"}`);
        expect(text).toContain("modifiedAt = ");
        expect(text).toContain("REMOVE marker");
        expect(text).not.toContain("count");
        expect(key).toEqual({ id: "o-1" });
        expect(valueConstructor).toBe(Order);
        expect(options).toEqual({ condition: statusIs });
    });

    it("removes a named attribute even when the item still carries a value for it", async () => {
        const executeSpy = jest
            .spyOn(mapper, "executeUpdateExpression")
            .mockImplementation(async (_expression: any, key: any) => order(key));

        await new OrderDAO().updateAndRemove(order({ status: "CLOSED", marker: "OPEN" }), ["marker"]);

        const text = render(executeSpy.mock.calls[0][0]);
        expect(text).toContain("REMOVE marker");
        expect(text).not.toContain('marker = {"S":"OPEN"}');
    });

    it("leaves update on its existing path", async () => {
        const updateSpy = jest.spyOn(mapper, "update").mockImplementation(async (item: any) => item);
        const executeSpy = jest.spyOn(mapper, "executeUpdateExpression");

        await new OrderDAO().update(order({ status: "CLOSED" }), false, 3600, statusIs);

        expect(updateSpy).toHaveBeenCalledWith(expect.any(Order), { onMissing: "skip", condition: statusIs });
        expect(executeSpy).not.toHaveBeenCalled();
    });
});

describe("BaseDAO.adjustNumericAttribute", () => {
    it("adds a positive delta to the attribute, starting from 0", async () => {
        const executeSpy = jest
            .spyOn(mapper, "executeUpdateExpression")
            .mockImplementation(async (_expression: any, key: any) => order(key));

        await new OrderDAO().adjustNumericAttribute(Order, { id: "o-1" }, "count", 3);

        const [expression, key, valueConstructor] = executeSpy.mock.calls[0];
        const text = render(expression);
        expect(text).toContain('count = if_not_exists(count, {"N":"0"}) + {"N":"3"}');
        expect(text).toContain("modifiedAt = ");
        expect(key).toEqual({ id: "o-1" });
        expect(valueConstructor).toBe(Order);
    });

    it("subtracts a negative delta", async () => {
        const executeSpy = jest
            .spyOn(mapper, "executeUpdateExpression")
            .mockImplementation(async (_expression: any, key: any) => order(key));

        await new OrderDAO().adjustNumericAttribute(Order, { id: "o-1" }, "count", -2);

        expect(render(executeSpy.mock.calls[0][0])).toContain('count = if_not_exists(count, {"N":"0"}) - {"N":"2"}');
    });

    it("accepts only numeric attributes", async () => {
        jest.spyOn(mapper, "executeUpdateExpression").mockImplementation(async (_expression: any, key: any) =>
            order(key)
        );

        // @ts-expect-error status is a string attribute
        await new OrderDAO().adjustNumericAttribute(Order, { id: "o-1" }, "status", 1);
    });
});
