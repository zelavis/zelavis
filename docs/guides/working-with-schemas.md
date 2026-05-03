# Working with Schemas

Zelavis database schemas stay intentionally close to plain objects.

That keeps them easy to serialize, store, and inspect, while still giving us room for small ergonomic helpers where they pay for themselves.

## Basic shape

```ts
await database.schemas.register({
  collection: "products",
  version: 1,
  activate: true,
  document: {
    type: "object",
    additionalProperties: false,
    required: ["name"],
    properties: {
      name: { type: "string", minLength: 1 },
    },
  },
});
```

## Native file-reference fields

Zelavis now supports file-reference fields directly in collection schemas.

You can write them by hand:

```ts
file: {
  type: "file",
  mimeTypes: ["image/png", "image/jpeg"],
  maxSize: 5_000_000,
}
```

or use the small helpers from `@zelavis/database`:

```ts
import {
  documentFileSchema,
  fileSchema,
  imageFileSchema,
} from "@zelavis/database";

await database.schemas.register({
  collection: "products",
  version: 1,
  activate: true,
  document: {
    type: "object",
    additionalProperties: false,
    required: ["name", "heroImage"],
    properties: {
      name: { type: "string", minLength: 1 },
      heroImage: imageFileSchema({ maxSize: 5_000_000 }),
      specSheet: documentFileSchema({ maxSize: 10_000_000 }),
      attachment: fileSchema({
        mimeTypes: ["application/octet-stream"],
      }),
    },
  },
});
```

Current helpers:

- `fileSchema(...)`
- `imageFileSchema(...)`
- `audioFileSchema(...)`
- `videoFileSchema(...)`
- `documentFileSchema(...)`

## What the file validator checks

A `type: "file"` field expects a Zelavis file reference object:

- `kind: "file"`
- `path`
- `href`
- `metadataHref`

It can also validate:

- `contentType` against `mimeTypes`
- `size` against `maxSize`

That means your documents can point at the storage service in a structured way instead of carrying ad hoc path strings.

## Where file references come from

The storage service returns ready-to-use Zelavis file references.

You can:

1. upload a file through `/zelavis/storage` or the storage API
2. copy the returned reference
3. store that reference inside a database document field validated with `type: "file"`

## Related docs

- [@zelavis/database](../packages/database.md)
- [Adapters and Fetch-Native Hosts](./adapters-and-fetch-native.md)
