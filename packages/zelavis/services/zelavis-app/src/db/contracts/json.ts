export type DatabaseJsonPrimitive = string | number | boolean | null;

export type DatabaseJson =
  | DatabaseJsonPrimitive
  | DatabaseJson[]
  | { [key: string]: DatabaseJson };

export type DatabaseJsonObject = { [key: string]: DatabaseJson };
