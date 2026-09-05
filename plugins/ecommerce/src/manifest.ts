/**
 * This package's own manifest, as data.
 *
 * The plugin declares its menu through `zelavis.menu.create`, which only works
 * inside a plugin execution context — so it has to be loaded rather than
 * composed as a live object. `loadPluginPackage` needs the manifest as a value
 * when there is no filesystem resolution to read `package.json` from, which is
 * the case for anything embedding this package directly.
 *
 * `test/manifest.test.mjs` asserts this stays identical to `package.json`.
 */
export const ECOMMERCE_MANIFEST = Object.freeze({
  name: "@zelavis/ecommerce",
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
