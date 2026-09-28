---
"zelavis": major
---

Resolve the bundled core services from the distribution instead of node_modules.

`zelavis` ships `@zelavis/app`, `@zelavis/auth`, `@zelavis/marketplace` and
`@zelavis/ui` inside its own `services/` folder, but resolved them by bare name
through `import.meta.resolve`, which looks in `node_modules` and finds nothing
there. Making that work required declaring all four as registry dependencies,
so the package could not be installed until each had been published on its own
— and two of them never had been.

Resolution now falls back to the folder that already ships beside the code.
Both the importer and the manifest resolver consult an index of
`services/*/package.json` when ordinary resolution finds nothing. An installed
copy of the same name still wins, because the fallback runs only after the
normal path fails, and the importer falls through only on `ERR_MODULE_NOT_FOUND`
so a package that throws while loading still surfaces its own error.

The four names are devDependencies now. The distribution installs and runs
standalone.
