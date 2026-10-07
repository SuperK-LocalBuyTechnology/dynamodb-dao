import { attribute } from "@nova-odm/annotations";

export class BaseModel {
    @attribute({
        defaultProvider: () => new Date(),
        type: "Date",
    })
    createdAt?: Date;

    @attribute({
        type: "Date",
        defaultProvider: () => new Date(),
    })
    modifiedAt?: Date;
}
