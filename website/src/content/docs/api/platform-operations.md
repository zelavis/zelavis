---
title: Platform Operations
---

Everything the Platform does is reachable three ways that answer alike, refusals included: the HTTP route, the JS SDK (`createZelavisClient`) and the CLI. This page maps the Platform's own operations to all three. Paths are under `/zelavis/api/v1/`. The Project-level operations are in [Project files and workloads](/api/project-files-and-workloads) and [App Data](/api/app-data); the database's are in [Database](/api/database).

Answers are the Platform's own JSON, passed through by the SDK and the CLI. `--url` and `--token` pick the Platform and the credential; `--json` prints the answer as JSON.

## Fabric

Needs `fabric.view`; planning needs `fabric.manage`.

| What | HTTP | SDK (`client.fabric.…`) | CLI (`zelavis fabric …`) |
|---|---|---|---|
| Snapshot of nodes and placements | `GET fabric/snapshot` | `snapshot()` | `snapshot` |
| Health | `GET fabric/health` | `health()` | `health` |
| Nodes, one node | `GET fabric/nodes`, `GET fabric/nodes/:nodeId` | `nodes()`, `node(id)` | `nodes`, `node ID` |
| Project placements, one | `GET fabric/placements/projects[/:projectId]` | `placements()`, `placement(projectId)` | `placements`, `placement ID` |
| Plan placements without applying them | `POST fabric/placements/projects/plan` with `{ requests }` | `plan(requests)` | `plan --data '[…]'` |
| Migrations in flight | `GET fabric/migrations` | `migrations()` | `migrations` |

## Assistant

Threads belong to the principal that made them; a change the Assistant proposes is an approval a person decides. Audit needs `server.assistant.audit`.

| What | HTTP (`runtime/assistant/…`) | SDK (`client.assistant.…`) | CLI (`zelavis assistant …`) |
|---|---|---|---|
| Audit trail | `GET audit?limit=&before=&principalId=&tool=&decision=` | `audit(query?)` | `audit [--limit N --before C --principal ID --tool NAME --audit-decision D]` |
| Platform model provider | `GET\|PUT\|DELETE provider` | `provider()`, `setProvider(body)`, `clearProvider()` | `provider`, `set-provider --data JSON`, `clear-provider` |
| A Project's own provider | `GET\|PUT\|DELETE projects/:projectId/provider` | `projectProvider(id)`, `setProjectProvider(id, body)`, `clearProjectProvider(id)` | `project-provider ID`, `set-project-provider ID --data JSON`, `clear-project-provider ID` |
| Threads | `GET threads[?projectId=]`, `POST threads`, `GET\|DELETE threads/:threadId` | `threads()`, `createThread({ title?, projectId? })`, `thread(id)`, `deleteThread(id)` | `threads [--project ID]`, `create-thread [--title T --project ID]`, `thread ID`, `delete-thread ID` |
| Send a message | `POST threads/:threadId/messages` with `{ content }` | `sendMessage(id, content)` | `send ID TEXT` |
| Read the reply as it is written | `POST threads/:threadId/messages/stream` (`text/event-stream`: `text`, `tool`, `done`, `error`) | `streamMessage(id, content)`, an async iterable of `{ event, data }` | `stream ID TEXT` |
| Decide an approval | `POST threads/:threadId/approvals/:approvalId` with `{ decision, confirm? }` | `decide(id, approvalId, { decision, confirm? })` | `decide ID APPROVAL --decision approve\|deny [--confirm ID]` |

## Deployment backends and the Agent

| What | HTTP (`runtime/…`) | SDK | CLI |
|---|---|---|---|
| Where Projects may run | `GET deployment-backends`, `POST deployment-backends/detect`, `POST deployment-backends/:id/enable\|disable\|default` | `client.deploymentBackends.list\|detect\|enable\|disable\|setDefault` | `zelavis backends list\|detect\|enable\|disable\|default [ID]` |
| What the Agent reports | `GET agent`, `GET agent/operations[/:operationId]` | `client.agent.status\|operations\|operation` | `zelavis agent status\|operations\|operation [ID]` |

With none of those words, `zelavis agent` runs the Agent itself.
