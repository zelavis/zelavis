import type { DatabaseJson } from "../contracts/json.js";
export declare function cloneJson<T extends DatabaseJson>(value: T): T;
export declare function cloneRecord<T extends Record<string, unknown>>(value: T): T;
export declare function parseOptionalJson<T>(value: string | null | undefined): T | undefined;
export declare function parseRequiredJson<T>(value: string): T;
export declare function generateId(prefix?: string): string;
export declare function toTimestampMs(value: number | string | Date): number;
export declare function readOptionalRecord(value: unknown): Record<string, unknown> | undefined;
export declare function payloadText(value: unknown): string;
