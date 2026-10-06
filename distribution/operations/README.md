# Host operation sources

Each release-shipped host operation lives at `<id>/<version>/`:

- `artifact` — the program, a script (with `interpreter` in `operation.json`)
  or a native executable.
- `operation.json` — the manifest without `sha256`:
  `{ "id", "version", "interpreter"?, "arguments": { ... } }`.

`stage-operations.mjs` (run when the package is built and by `pnpm distribution:stage`)
computes each digest and writes `operations/<id>/<version>/{manifest.json, artifact}`
into the release tree. The manifest is plain: the installed tree is root-owned and the
Agent refuses to load a manifest that is not, so there is no signature to produce.
