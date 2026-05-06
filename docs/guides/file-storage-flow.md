# File Storage Flow

This guide shows the intended Zelavis flow for files:

1. upload a file into the storage core service
2. copy the generated Zelavis file reference
3. validate that reference in a database document with a file-aware schema

## Why this flow exists

Zelavis treats file storage and the database as separate layers:

- storage owns bytes, headers, and file metadata
- database documents store structured references to those files

That separation keeps uploads portable across platforms while still letting documents validate and reason about media.

## 1. Start a runtime with storage

The easiest local setup is the Node example:

```bash
pnpm --filter @zelavis/example-nodejs dev
```

Open:

- `http://localhost:3000/zelavis/storage`
- `http://localhost:3000/zelavis/database`

## 2. Upload a file

From `/zelavis/storage`:

- choose or drag a file
- optionally add metadata such as `label`, `alt`, or `purpose`
- optionally set HTTP delivery headers such as `Cache-Control` or `Content-Disposition`
- upload the file

After the upload, Zelavis gives you:

- stored file metadata
- checksum information when available
- a ready-to-use Zelavis file reference JSON object

## 3. Define a file-aware schema

Use the database schema helpers when the field is meant to store a file reference:

```ts
import { createDatabase, imageFileSchema } from "@zelavis/database";

const database = createDatabase();

await database.createCollection({
  name: "posts",
  schema: {
    title: {
      type: "string",
    },
    heroImage: imageFileSchema({
      optional: true,
      maxSize: 5_000_000,
    }),
  },
});
```

Other helpers are available too:

- `fileSchema(...)`
- `audioFileSchema(...)`
- `videoFileSchema(...)`
- `documentFileSchema(...)`

## 4. Insert the copied file reference into a document

After copying the reference JSON from the storage panel, insert it directly into a document:

```ts
await database.insertDocument({
  collection: "posts",
  data: {
    title: "Spring launch",
    heroImage: {
      kind: "file",
      path: "uploads/hero.jpg",
      href: "/zelavis/api/v1/storage/files/uploads/hero.jpg",
      metadataHref:
        "/zelavis/api/v1/storage/files/uploads/hero.jpg?format=metadata",
      contentType: "image/jpeg",
      size: 183245,
      checksum: "sha256:...",
      metadata: {
        label: "Homepage hero",
        alt: "Product photo on white background",
      },
    },
  },
});
```

The storage dashboard now also includes a quick action that creates a sample `storage_assets` document from the selected file reference, which is handy for testing the flow end to end.

## S3-compatible storage

When you want object storage outside the built-in platform presets, Zelavis now exposes a first-party helper:

```ts
import { createS3CompatibleFileStorage } from "zelavis/storage/s3";
```

That helper stays inside the Zelavis storage contract instead of routing through `unstorage`. It is a better fit for Zelavis because it preserves:

- Zelavis file metadata
- `Cache-Control`
- `Content-Disposition`
- custom metadata headers
- the same file-reference flow used by the dashboard and database

Use it when the deployment target is generic S3-compatible object storage rather than a platform-specific preset like Cloudflare R2 or Vercel Blob.

It also ships a few CDN-friendly cache presets:

- `immutableAsset`
- `browserShort`
- `edgeShort`
- `privateDocument`
- `noStore`
