# Host operation sources

Each release-shipped host operation lives at `<id>/<version>/`:

- `artifact` — the program, a script (with `interpreter` in `operation.json`)
  or a native executable.
- `operation.json` — the manifest without `sha256`:
  `{ "id", "version", "interpreter"?, "arguments": { ... } }`.

`pnpm distribution:stage` computes each digest, signs the manifest with the
release key (`ZELAVIS_OPERATION_SIGNING_KEY`, `ZELAVIS_OPERATION_SIGNING_KEY_ID`)
and writes `operations/<id>/<version>/{manifest.json, artifact}` into the
release tree, verifying the result against `release.json` `operationTrust`.
There are no shipped operations yet.
