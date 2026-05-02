import {
  createPlatform,
  type ZelavisConstructorOptions,
  type ZelavisFileStorage,
  type ZelavisKeyValueStore,
  type ZelavisPlatformPreset,
  type ZelavisResolvedPlatformOptions,
} from "../index.js";

export interface VercelPlatformOptions {
  database?: false | unknown;
  kv?: false | {
    store: ZelavisKeyValueStore;
  };
  files?: false | {
    storage: ZelavisFileStorage;
  };
  metadata?: Record<string, unknown>;
}

export function vercelPlatform(
  options: VercelPlatformOptions = {},
): ZelavisPlatformPreset {
  return createPlatform({
    name: "vercel",
    async resolve(
      constructorOptions: ZelavisConstructorOptions<any>,
    ): Promise<ZelavisResolvedPlatformOptions> {
      const nextCoreServices: Record<string, unknown> = {};

      if (
        constructorOptions.coreServices?.database !== false &&
        options.database !== false &&
        options.database !== undefined
      ) {
        nextCoreServices.database = options.database as Record<string, unknown>;
      }

      return {
        coreServices: nextCoreServices,
        resources: {
          kv: options.kv ? options.kv.store : undefined,
          files: options.files ? options.files.storage : undefined,
        },
        metadata: {
          runtime: "vercel",
          ...(options.metadata ?? {}),
        },
      };
    },
  });
}
