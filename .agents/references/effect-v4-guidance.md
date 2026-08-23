# Effect v4 Reference & Guidance

This project uses **Effect v4** with the source code vendored under `repos/effect/`.

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
- Branded types: `Schema.String.pipe(Schema.brand("MyBrand"))`.

### 2. Decoding & Encoding
- `Schema.decodeUnknownEither(MySchema)(data)`
- `Schema.decodeUnknownSync(MySchema)(data)`
- `Schema.decodeUnknownPromise(MySchema)(data)`
- `Schema.encodeSync(MySchema)(entity)`

### 3. Usage Rules
- `repos/effect/` is strictly **read-only reference material**.
- Never import from `repos/effect/` in application code; always import from `effect` or subpaths like `effect/Schema`.
