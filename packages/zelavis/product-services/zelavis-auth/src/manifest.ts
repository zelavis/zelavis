/**
 * This package's own manifest, as data.
 *
 * Loaded through `loadPluginPackage`, the same loader an installed third-party
 * plugin goes through, so it needs its manifest as a value: a first-party
 * service shipping inside the Platform has no install step and therefore no
 * filesystem resolution to read `package.json` from.
 *
 * Typed locally rather than as `ZelavisPackageManifest`. This package compiles
 * before `zelavis` does, so at this point only `zelavis/sdk` exists to import.
 */
export const AUTH_SETTINGS_MANIFEST = Object.freeze({
  name: "@zelavis/auth",
  version: "1.0.1-alpha.2",
  type: "module",
  exports: Object.freeze({
    ".": Object.freeze({
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
    }),
  }),
  zelavis: Object.freeze({ kind: "plugin" }),
});
