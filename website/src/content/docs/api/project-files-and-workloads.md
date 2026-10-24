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

`zelavis storage get` prints text as is and anything else as base64 with `--json`; `--output FILE` writes the bytes untouched.

## Workloads

A workload is `{ type: "function" \| "job" \| "schedule" \| "webhook", name, code?, route?, schedule?, enabled? }`. The Project is the client's: the SDK and CLI send it, so one client cannot read another Project's workloads by mistake.

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
