export type JsonPrimitive = string | number | boolean | null;

export type Json = JsonPrimitive | Json[] | { [key: string]: Json };

export type JsonObject = { [key: string]: Json };
