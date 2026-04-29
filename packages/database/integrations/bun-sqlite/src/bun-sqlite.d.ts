declare module "bun:sqlite" {
  export interface DatabaseOptions {
    readonly?: boolean;
    create?: boolean;
    readwrite?: boolean;
    safeIntegers?: boolean;
    strict?: boolean;
  }

  export interface RunResult {
    lastInsertRowid: number | bigint;
    changes: number;
  }

  export interface Statement<
    ReturnType = Record<string, unknown>,
    ParamsType = unknown,
  > {
    all(...params: ParamsType[]): ReturnType[];
    get(...params: ParamsType[]): ReturnType | null;
    run(...params: ParamsType[]): RunResult;
    values(...params: ParamsType[]): unknown[][];
    finalize(): void;
  }

  export class Database {
    constructor(filename?: string, options?: DatabaseOptions | number);
    query<ReturnType = Record<string, unknown>, ParamsType = unknown>(
      sql: string,
    ): Statement<ReturnType, ParamsType>;
    prepare<ReturnType = Record<string, unknown>, ParamsType = unknown>(
      sql: string,
    ): Statement<ReturnType, ParamsType>;
    run(sql: string, ...params: unknown[]): RunResult;
    exec(sql: string, ...params: unknown[]): RunResult;
    transaction<TArgs extends unknown[], TResult>(
      insideTransaction: (...args: TArgs) => TResult,
    ): ((...args: TArgs) => TResult) & {
      deferred: (...args: TArgs) => TResult;
      immediate: (...args: TArgs) => TResult;
      exclusive: (...args: TArgs) => TResult;
    };
    close(throwOnError?: boolean): void;
  }
}
