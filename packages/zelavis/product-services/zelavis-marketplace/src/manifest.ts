import type { ZelavisPackageManifest } from "zelavis/core";

/**
 * This package's own manifest, as data.
 *
 * The marketplace is loaded through `loadPluginPackage`, the same loader that
 * runs an installed third-party plugin, so it needs its manifest as a value.
 * A first-party service that ships inside the Platform has no install step and
 * therefore no filesystem resolution to read `package.json` from.
 *
 * `test/manifest.test.mjs` asserts this stays identical to `package.json`.
 */
export const MARKETPLACE_MANIFEST: ZelavisPackageManifest = Object.freeze({
  name: "@zelavis/marketplace",
  version: "1.0.1-alpha.2",
  type: "module",
  exports: Object.freeze({
    ".": Object.freeze({
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
    }),
  }),
  zelavis: Object.freeze({ kind: "plugin" }),
}) as ZelavisPackageManifest;
