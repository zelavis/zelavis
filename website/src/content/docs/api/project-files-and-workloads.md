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

A workload is `{ type: "function" \| "job" \| "schedule" \| "webhook" \| "entity", name, code?, route?, schedule?, tenant?, url?, secret?, signatureHeader?, eventIdHeader?, enabled? }`. The Project is the client's: the SDK and CLI send it, so one client cannot read another Project's workloads by mistake.

| What | HTTP | SDK (`client.workloads(projectId).…`) | CLI (`zelavis workloads … --project ID`) |
|---|---|---|---|
| Health | `GET workloads/health` | `health()` | `health` |
| Menu of one kind | `GET workloads/menu/:section` | `menu(section)` | `menu SECTION` |
| List, optionally one type | `GET workloads?projectId=&type=` | `list({ type? })` | `list [--type T]` |
| Create | `POST workloads` | `create(body)` | `create --data JSON` |
| Read | `GET workloads/:id` | `get(id)` | `get ID` |
| Replace a definition | `PUT workloads/:id` | `update(id, body)` | `update ID --data JSON` |
| Run now (a job: enqueue a run) | `POST workloads/:id/run` | `run(id, options?)` | `run ID [--data JSON]` |
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

The Project runtime serves its durable entities with the enabled entity workloads, so a handler added, changed or
disabled takes effect without a restart, and messages that waited for a handler are looked at again when one appears. Messages are sent through the database
(`client.data(projectId).entities.send`, `zelavis entities send`), not `run`. The dashboard shows an entity workload's
entities, their state and mailboxes, and sends messages from its page.

## Durable jobs, schedules and webhooks

Jobs, schedules and webhooks run on the same durable entities. Their code has an entity handler's shape (a message and
the context in, a step out whose writes, outbox messages, state and reply commit with the message's processed mark), so
their database effects land once however often a message is delivered; delivery to the code is at least once. All of
it is served by the Project runtime where the database's writer is, from the enabled workloads, reread when one is
created or replaced (and in full once a minute as a safety net). Nothing polls: outbound webhooks are read when outbox
messages are committed in the process, schedules are armed for their fire time, and a failed delivery waits for its retry
time. Each has a row in [Delivery guarantees](../../architecture/delivery-guarantees/).

| Kind | What is durable | Entity | Notes |
|---|---|---|---|
| Job | A run is a message in its Tenant's mailbox until the code has handled it | `job` / the job's name | `run` enqueues it: `tenantId` (or the job's `tenant`), `input` (the message payload), `primaryKey` (a resend is the same run), `deliverAt`. Runs of one job go one at a time, in order; a failure is retried with doubling pauses, then marked failed. |
| Schedule | The next wake is a pending message, keyed by its fire time, with `deliverAt` | `schedule` / the schedule's name | `schedule` is a cron expression (five fields, or six with seconds first), in UTC. The wake is armed only where the writer runs. A wake that waited out downtime fires once on return, however many fires were missed. Disabling withdraws the wake. |
| Inbound webhook | The event is saved before it is answered | `webhook` / the webhook's name | `POST workloads/webhooks/:projectId/:name`. With a `secret`, the body must carry a `sha256=<hex>` HMAC in `signatureHeader` (`x-hub-signature-256`); with `signatureScheme: "timestamped"` the header is `t=<unix seconds>,v1=<hex>` (`stripe-signature`), signed over `<t>.<body>`, and a time more than five minutes away is refused. The event id is the `eventIdHeader` header, else the body's `id`, and is the message's `primaryKey`, so a provider's retry answers `202` with `duplicate: true`. A full mailbox answers `503` with `retry-after`. Credentials and the signature are not kept. |
| Outbound webhook | An outbox message with topic `webhook.<name>` in the webhook's `tenant` | none | Delivered to `url` as JSON `{ id, topic, payload, emittedAt }` with an `Idempotency-Key` header equal to the message id and, with a `secret`, an `x-zelavis-signature` header. A 2xx removes the message; anything else is retried with doubling pauses, eight attempts, then it stays in the outbox until the runtime next starts. Redirects are not followed. |

The `secret` is write-only: reads answer `secretSet`. `job`, `schedule` and `webhook` are the entity types of those
workloads, so an `entity` workload cannot take those names. Schemes other than those two HMACs are not verified by
Zelavis, and a webhook without a `secret` accepts any caller, so give every inbound webhook a secret.

## Recovering an asynchronous provider result

A document conversion service can accept a request and finish it later. Keep the conversion's status in an App
document so it can still be checked if the completion callback never arrives. Use the same Tenant for the document,
the outbound `provider-submit` webhook, the inbound `provider-result` webhook, and the `provider-check` job.

Create the `provider-requests` collection, then save the `pending` record and enqueue the submission in one
[document write](../database/#outbox). Generate a request ID unique to the provider account and reuse it when
retrying the same submission. Here `tenantDb` is the App's database handle for that Tenant.

```js
const requestId = 'conversion-42';
await tenantDb.documents.write({
  operations: [{ _tag: 'Insert', collection: 'provider-requests', id: requestId, data: { status: 'pending' } }],
  emit: [{ id: requestId, topic: 'webhook.provider-submit', payload: { requestId } }],
  idempotencyKey: requestId,
});
```

Configure `provider-submit` for a receiver that accepts the Workloads envelope and deduplicates submissions by
`Idempotency-Key`. Zelavis sends the outbox ID in that header and removes the entry on a `2xx`. The conversion
stays `pending` until its outcome is known. If the provider accepted the request and its response was lost, the
outbox may send it again with the same key. Safe replay depends on the receiver honoring that key. If the provider
lacks that contract, use a provider-specific sender that resolves an uncertain submission through the provider's
status mechanism or operator review before resubmitting.

Configure `provider-result` with a shared secret when the provider signs callbacks using a supported HMAC scheme. In this example,
the callback body contains an event `id`, the `requestId`, and a terminal status of `succeeded` or `failed`.
The event ID deduplicates the callback, and the request ID selects the existing document. A callback `202` means
Zelavis saved the event in its mailbox. The handler validates the body and returns a step that records the result
when the message is processed.

When the callback is missing, an authorized caller can enqueue `provider-check` with the same request ID. The job
checks that the App record is pending, then reads the provider's status at its configured endpoint with a deadline.
Use the same primary key to retry enqueuing the same check. Use a new primary key when deliberately checking again.

```js
const primaryKey = `check-${requestId}-1`;
await client.workloads(projectId).run(providerCheckId, {
  input: { requestId },
  primaryKey,
});

const check = await client.data(projectId).entities.message({
  type: 'job', id: 'provider-check', messageKey: primaryKey, tenantId,
});
```

`providerCheckId` is the job definition's ID. The message lookup uses its name, `provider-check`, and requires data
read access to the Tenant. See the [Workloads table](#workloads) and [entity message lookup](../database/#durable-entities)
for the HTTP and CLI forms. A `processed` check can report that the provider is still pending. Read the App document
for the conversion's current status.

Both handlers apply terminal results the same way. Validate that the provider's response identifies the expected
request, then read that document and return an `Update` in the handler's `writes` with `expectedVersion` from the
read. The update and the processed mark commit together. If a callback and a check race, the version check refuses
the stale write and the retry reads the current record. Leave a terminal record unchanged on a repeated result and
surface contradictory terminal results for inspection. Unknown requests, malformed responses, and unavailable status
checks leave the stored outcome alone. Adapt the authentication, correlation and status checks to the provider's
documented contract.
