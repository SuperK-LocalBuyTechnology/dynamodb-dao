# @superk-in/dynamodb-dao

A typed, minimal DAO layer for DynamoDB on top of [nova-odm](https://github.com/nova-odm/nova-odm).
You declare a model class with decorators, extend `BaseDAO<T>`, and get `get`, `save`, `update`,
`delete`, batch operations, queries, pagination and an optional cache for free.

## Install

```bash
npm install @superk-in/dynamodb-dao \
  @nova-odm/annotations @nova-odm/expressions @nova-odm/mapper @nova-odm/marshaller \
  @aws-sdk/client-dynamodb
```

The nova-odm packages and the AWS SDK client are peer dependencies, so you control their versions.
Your `tsconfig.json` needs `experimentalDecorators: true` and `emitDecoratorMetadata: true`.

## Usage

```ts
import { hashKey, attribute, table } from "@nova-odm/annotations";
import { BaseDAO, BaseModel } from "@superk-in/dynamodb-dao";

@table("widgets")
export class Widget extends BaseModel {
    @hashKey({ type: "String" }) id: string;
    @attribute() name: string;
}

export class WidgetDAO extends BaseDAO<Widget> {
    constructor() {
        super("id"); // hash key name; add a second argument for a range key
    }
}

const dao = new WidgetDAO();
await dao.save(Object.assign(new Widget(), { id: "1", name: "first" }));
const widget = await dao.get(Object.assign(new Widget(), { id: "1" }));
```

`BaseModel` adds `createdAt` and `modifiedAt` (both `Date`, defaulted at save time).

## Configuration

Call `configureDao` once at startup, before the first DAO call. Every option is optional.

```ts
import { DynamoDB } from "@aws-sdk/client-dynamodb";
import { configureDao } from "@superk-in/dynamodb-dao";

configureDao({
    client: new DynamoDB({ region: "eu-west-1", maxAttempts: 5 }),
    cache: myCache,
    strictCacheKeyCheck: true,
});
```

| Option                | Default                               | Meaning                                                                               |
| --------------------- | ------------------------------------- | ------------------------------------------------------------------------------------- |
| `client`              | `new DynamoDB({ maxAttempts: 10 })`   | Your own DynamoDB client (region, endpoint, credentials, retries).                    |
| `cache`               | none                                  | A `CacheAdapter`. Without one, `fromCache` / `storeInCache` do nothing.               |
| `strictCacheKeyCheck` | `false`                               | Throw when `storeInCache` is used by a DAO constructed without a hash key name.       |

### Caching

Plug in any cache that matches this interface:

```ts
interface CacheAdapter {
    get<T>(key: string): T | undefined;
    set<T>(key: string, value: T, ttlSeconds?: number): void;
    del(key: string): void;
}
```

For example, `node-cache` already fits: `configureDao({ cache: new NodeCache() })`. Cache keys are
`<daoName>_<hashKey>[_<rangeKey>]`, where `daoName` is the class name without the `DAO` suffix, lower-cased.
Writes and deletes through the DAO keep the cache in sync. The cache needs a hash key name in the DAO constructor.

### Errors

`getAndUpdate` returns (does not throw) a `DaoError { statusCode, message }` when your validation function
returns an error. Use `DaoError.isDaoError(value)` to tell it apart from a model.

## License

MIT
