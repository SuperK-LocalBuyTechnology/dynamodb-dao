/**
 * Error value returned (not thrown) by BaseDAO.getAndUpdate when validation fails.
 * Structurally `{ statusCode, message }`, so it is interchangeable with similarly shaped error objects.
 */
export class DaoError {
    statusCode: number;
    message: string;

    constructor(statusCode: number, message: string) {
        this.statusCode = statusCode;
        this.message = message;
    }

    static isDaoError(object: unknown): object is DaoError {
        if (object === null || object === undefined || typeof object !== "object") {
            return false;
        }
        return object instanceof DaoError || ("statusCode" in object && "message" in object);
    }
}
