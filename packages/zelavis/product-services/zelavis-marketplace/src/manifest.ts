/**
 * This package's own manifest, as data.
 *
 * The marketplace is loaded through `loadPluginPackage`, the same loader that
 * runs an installed third-party plugin, so it needs its manifest as a value.
 * A first-party service that ships inside the Platform has no install step and
 * therefore no filesystem resolution to read `package.json` from.
 *
 * `test/marketplace.test.mjs` asserts this stays identical to `package.json`.
 *
 * Typed locally rather than as `ZelavisPackageManifest`. This package compiles
 * before `zelavis` does — see the build order in `packages/zelavis/package.json`
 * — so at this point only `zelavis/sdk` exists to import from.
 */
export const MARKETPLACE_MANIFEST = Object.freeze({
  name: "@zelavis/marketplace",
  version: "1.0.1-alpha.2",
  type: "module",
  exports: Object.freeze({
    ".": Object.freeze({
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
    }),
  }),
  zelavis: Object.freeze({ kind: "core" }),
});
