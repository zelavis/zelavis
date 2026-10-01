# Effect v4 Reference & Guidance

This project uses **Effect v4** (stable `4.0.0`, exact pin) with the source code vendored
under `repos/effect/`, at the matching release tag (see `repos/effect/VENDORED_FROM`).
Refresh it with `scripts/update-effect-source.sh effect@<version>` whenever the pin changes.

## Authoritative Reference Paths

- `repos/effect/LLMS.md`: Official Effect v4 overview and cheat sheet.
- `repos/effect/packages/effect/SCHEMA.md`: Schema v4 definitions, transforms, and error handling.
- `repos/effect/packages/effect/HTTPAPI.md`: HttpApi v4 contracts and handlers.
- `repos/effect/packages/effect/src/`: Actual Effect source code (interfaces, combinators, services).
- `repos/effect/packages/effect/test/`: Comprehensive real-world usage examples and test patterns.

## Important Effect v4 Patterns

### 1. Schema Definition
- In v4, use `Schema.Struct` for object schemas (not v3 `Schema.struct`).
- Primitives: `Schema.String`, `Schema.Number`, `Schema.Boolean`, `Schema.Date`, `Schema.Array(...)`, `Schema.Record(...)`.
- Branded types: `Schema.String.pipe(Schema.brand("MyBrand"))`. A brand is a single
  identifier and exists only in the type (it is not stored in the schema's AST):
  apply `Schema.brand` again for a second brand, and reapply it after rebuilding a
  schema from a `SchemaRepresentation`.

### 2. Decoding & Encoding
- `Schema.decodeUnknownResult(MySchema)(data)` (v4 replaced `Either` with `Result`;
  there is no `decodeUnknownEither`)
- `Schema.decodeUnknownEffect`, `decodeUnknownExit`, `decodeUnknownOption`
- `Schema.decodeUnknownSync(MySchema)(data)`
- `Schema.decodeUnknownPromise(MySchema)(data)`
- `Schema.encodeSync(MySchema)(entity)`
- Check the exact export in `repos/effect/packages/effect/src/Schema.ts` before
  using a helper; names changed between v3 and v4.

### 3. Module paths that moved in 4.0.0
- `effect/Encoding` is gone: use `effect/encoding/Base64`, `Base64Url`, `Hex`
  (`Base64Url.encode`, `Base64.decode`, `Hex.random`, ...) and `effect/encoding/EncodingError`.
- `KeyValueStore` is at `effect/persistence/KeyValueStore`, not under `effect/unstable/`.
- The former `@effect/platform`, `rpc`, `cluster`, `cli`, `sql`, `workflow` packages are
  part of `effect` (`effect/http`, `effect/http-api`, `effect/rpc`, ...). Check
  `repos/effect/packages/effect/package.json` `exports` rather than guessing a path.
- APIs tagged `@stability unstable` can change between releases; the Effect language
  service warns on them (`effect(unstableApiUsage)`). Acknowledge one deliberately,
  with the reason, in the one file that needs it, as `src/db/key-value-effect.ts` does.
- When an Effect API seems to have changed, read `repos/effect/packages/effect/CHANGELOG.md`.

### 4. Usage Rules
- `repos/effect/` is strictly **read-only reference material**.
- Never import from `repos/effect/` in application code; always import from `effect` or subpaths like `effect/Schema`.
