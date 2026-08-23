export function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}
export function cloneRecord(value) {
    return JSON.parse(JSON.stringify(value));
}
export function parseOptionalJson(value) {
    if (!value) {
        return undefined;
    }
    return JSON.parse(value);
}
export function parseRequiredJson(value) {
    return JSON.parse(value);
}
export function generateId(prefix = "doc") {
    if (typeof globalThis.crypto?.randomUUID === "function") {
        return `${prefix}_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
    }
    return `${prefix}_${Date.now().toString(36)}_${Math.random()
        .toString(36)
        .slice(2, 10)}`;
}
export function toTimestampMs(value) {
    if (value instanceof Date) {
        return value.getTime();
    }
    if (typeof value === "number") {
        return value;
    }
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) {
        throw new TypeError(`Invalid timestamp value: ${value}`);
    }
    return timestamp;
}
export function readOptionalRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : undefined;
}
export function payloadText(value) {
    return JSON.stringify(value);
}
