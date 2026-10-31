---
title: Project Files and Workloads
---

An App Project keeps files in storage and runs workloads: functions, jobs, schedules and webhooks. Both belong to the Project's runtime, so an operator reaches them through the Project proxy with the caller's own Project authority, not through the App data route that carries a Tenant's records. Every operation is in all three forms: the HTTP route, the SDK and the CLI, and the three answer alike, refusals included.

HTTP paths below are under `/zelavis/api/v1/runtime/projects/:projectId/proxy/zelavis/api/v1/`. `project.view` carries the reads (`storage.read`, `workloads.view`); `project.runtime.manage` carries writes, runs and logs (`storage.write`, `workloads.manage`, `workloads.logs.read`).

## Files

Paths are slash-separated; `.`, `..` and empty segments are refused. A write replaces what was there, and records a SHA-256 checksum of the bytes.

| What | HTTP | SDK (`client.storage(projectId).…`) | CLI (`zelavis storage … --project ID`) |
|---|---|---|---|
| List, optionally under a prefix | `GET storage/files?prefix=` | `list(prefix?)` | `list [prefix]` |
| A file's description and reference | `GET storage/files/:path?format=metadata` | `metadata(path)` | `metadata PATH` |
| A file's bytes and headers | `GET storage/files/:path` | `read(path)` | `get PATH [--output FILE]` |
| Store bytes or text | `PUT storage/files/:path` (raw body, `content-type`, `cache-control`, `content-disposition`, `x-file-meta-NAME`) | `write(path, bytes \| text, { contentType?, cacheControl?, contentDisposition?, metadata? })` | `put PATH --file FILE \| --text TEXT [--content-type T] [--cache-control V] [--content-disposition V] [--metadata JSON]` |
| Remove | `DELETE storage/files/:path` | `delete(path)` | `delete PATH` |
| Copy in from another system | `POST storage/import` with `{ source, into?, after?, limit? }` | `import({ source, into?, after?, limit? })` | `import --data JSON` |
| Quota and usage | `GET\|PUT storage/quota` with `{ maxBytes?, maxFileBytes? }` | `quota()`, `setQuota(input)` | `quota`, `set-quota --data JSON` |
| Signed upload link | `POST storage/uploads` with `{ path, maxBytes, contentType?, expiresInSeconds? }` | `createUpload(input)` (answers `url`) | `create-upload --data JSON` |
| Send an upload's bytes | `PUT /zelavis/api/v1/runtime/projects/:projectId/uploads/:token` (no credentials) | `upload(token, bytes, { contentType? })` | `upload TOKEN --file FILE [--content-type T]` |
| Confirm an upload | `POST storage/uploads/:id/confirm` with `{ sha256?, size? }` | `confirmUpload(id, expect?)` | `confirm-upload ID [--data JSON]` |
| Remove abandoned uploads | `POST storage/uploads/cleanup` | `cleanupUploads()` | `cleanup-uploads` |

**Quota.** A storage may hold at most `maxBytes` in all and `maxFileBytes` per file (each optional). Every write,
import and confirmed upload is checked against it, one at a time, so two writes cannot both pass a check only one
fits under. Setting it needs `storage.manage` (carried by `project.runtime.manage`); the dashboard's storage page
shows usage and sets it. The `.zelavis/` prefix holds the storage's own state and is refused to the file routes.

**Signed direct uploads.** A caller allowed to write asks for an upload link for a path, a size limit, an optional
content type and a lifetime of at most an hour. The token is an HMAC, under a key the storage keeps for itself, over
those terms, so whoever holds the link cannot change them. A browser `PUT`s the bytes to the link with no
credentials; they are refused past the size, with another type, after expiry, or a second time. The bytes wait in
staging with their SHA-256 until a caller allowed to write confirms the upload, checking it is the expected file
(`sha256`, `size`): that is the moment an App ties the file to its record. Uploads never confirmed are removed by
cleanup once expired.

**Importing media.** `storage/import` copies files from another system's S3-compatible bucket (Supabase Storage,
MinIO, Cloudflare R2, Google Cloud Storage's S3 interoperability): `source` is `{ kind: "s3", bucket, region,
accessKeyId, secretAccessKey, endpoint?, prefix?, forcePathStyle? }`. Up to `limit` (1 to 500, default 100) files
under the prefix are copied per call, in path order, under `into`; continue with `after` set to the answer's `next`.
Each copy records its SHA-256 and `imported-from`, and a file already here with the same digest is skipped, so a
repeated or resumed import copies nothing twice. The source's credentials are used for the call and never kept.
Only S3-compatible sources are read; arbitrary URLs are not fetched. Needs `storage.write`.

`zelavis storage get` prints text as is and anything else as base64 with `--json`; `--output FILE` writes the bytes untouched.

## Workloads

A workload is `{ type: "function" \| "job" \| "schedule" \| "webhook" \| "entity", name, code?, route?, schedule?, enabled? }`. The Project is the client's: the SDK and CLI send it, so one client cannot read another Project's workloads by mistake.

| What | HTTP | SDK (`client.workloads(projectId).…`) | CLI (`zelavis workloads … --project ID`) |
|---|---|---|---|
| Health | `GET workloads/health` | `health()` | `health` |
| Menu of one kind | `GET workloads/menu/:section` | `menu(section)` | `menu SECTION` |
| List, optionally one type | `GET workloads?projectId=&type=` | `list({ type? })` | `list [--type T]` |
| Create | `POST workloads` | `create(body)` | `create --data JSON` |
| Read | `GET workloads/:id` | `get(id)` | `get ID` |
| Replace a definition | `PUT workloads/:id` | `update(id, body)` | `update ID --data JSON` |
| Run now | `POST workloads/:id/run` | `run(id)` | `run ID` |
| Recent logs | `GET workloads/logs?projectId=&workloadId=` | `logs({ workloadId? })` | `logs [--workload ID]` |

A function with a `route` is also served over HTTP at `workloads/http/:projectId/*path`; that endpoint is the function's own, not a management operation.

An `entity` workload is the handler of the [durable entity](../database/#durable-entities) type it is named after (a
letter, then up to 63 lowercase letters, digits, `_` or `-`). Its code exports a function taking one message and the
entity's context and answering a step:

```js
export default async function handle(message, { state, tenant, documents }) {
  const count = (state?.count ?? 0) + 1;
  return { state: { count }, reply: { count } }; // also `writes` and `emit`, committed with the message
}
```

The Project runtime serves its durable entities with the enabled entity workloads, rereading them every two seconds, so
a handler added, changed or disabled takes effect without a restart. Messages are sent through the database
(`client.data(projectId).entities.send`, `zelavis entities send`), not `run`. The dashboard shows an entity workload's
entities, their state and mailboxes, and sends messages from its page.
