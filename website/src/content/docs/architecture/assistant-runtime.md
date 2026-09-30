---
title: Assistant Runtime
---
The Zelavis Assistant is a Platform OS capability with a dashboard client. It
is not a React-only chat widget and it is not tied to a managed AI platform.

## Ownership

The `zelavis` package owns:

- `ZelavisAssistantManager` thread and message operations
- project-scoped thread records in the Platform System Store
- the replaceable `ZelavisAssistantResponder` contract
- versioned endpoints under `/zelavis/api/v1/runtime/assistant`

`@zelavis/ui` uses the official assistant-ui Thread component and its composable
runtime primitives. It calls Zelavis endpoints through the normal dashboard
runtime client. Zelavis does not use Assistant Cloud or the Vercel AI SDK for
this integration.

## Current API

```txt
GET  /zelavis/api/v1/runtime/assistant/threads
POST /zelavis/api/v1/runtime/assistant/threads
GET  /zelavis/api/v1/runtime/assistant/threads/:threadId
POST /zelavis/api/v1/runtime/assistant/threads/:threadId/messages
POST /zelavis/api/v1/runtime/assistant/threads/:threadId/messages/stream
```

The `stream` variant answers with `text/event-stream`. Everything that can be
refused (no such thread, no Project access, empty message) is refused with a
real status before the stream opens. After that the events are `text`
(`{delta}`), `tool` (`{name, status: running|done|refused}`), then either
`done` (the saved thread and both messages) or `error` (a safe message). The
saved message is authoritative over what was streamed. A failed or cancelled
turn saves nothing, closing the connection cancels the provider call, and a
turn is capped at two minutes. Responders that cannot stream still reach a
streaming client as one `text` event.

Threads belong to the principal that started them. Another principal cannot
list, read or extend a thread and gets `404`, so it cannot learn the thread
exists. A thread may carry a `projectId`; `assistant.use` only allows chatting,
so the Project's own `project.view` permission is checked on create, list, read
and every message, and losing it closes the thread to its owner too.

## Implemented Today

- persistent threads and messages through the System Store
- project-scoped thread listing
- desktop chat workspace and compact mobile slide workspace
- structured dashboard navigation actions in Assistant replies
- a replaceable responder contract
- a deterministic built-in responder named `zelavis-local-router`

The built-in responder is not a language model. It recognizes a small set of
supported platform intents and returns text plus safe dashboard links.

## Model and tools

`Zelavis({ assistant: { model } })` answers with a language model behind the
thin `AssistantModel` seam. `createOpenRouterModel({ apiKey, model })` is the
first provider (plain `fetch`, HTTPS only, bounded responses, provider errors
never echo the key). The seam knows nothing about threads or permissions.

The Admin Agent is not a principal. It borrows the caller's authority:

- a tool call is authorized at execution against the caller's permissions, with
  a scope built from that call's own arguments, never from the thread or prompt
- tools are advertised only to callers who hold their permissions at some scope
  (a convenience, not the gate)
- refusals (`forbidden`, `invalid_arguments`, `unknown_tool`, `failed`,
  `audit_unavailable`) are returned to the model as structured data
- every call is audited with principal, arguments and decision in the System
  Store, and a call that cannot be audited does not run
- the system prompt enforces nothing

### Provider configuration

Without a model in code, the provider is resolved on every message: the
environment (`ZELAVIS_ASSISTANT_OPENROUTER_API_KEY` and `ZELAVIS_ASSISTANT_MODEL`,
which win and cannot be changed through the API), then a setting stored through
`GET|PUT|DELETE /zelavis/api/v1/runtime/assistant/provider`, then none, in which
case the deterministic local router answers. Those routes need
`system.settings.manage`. The key is encrypted with the Platform master secret,
never returned (callers only learn `hasApiKey`), and never written to threads,
audit records or errors; changes are audited without it. The master secret lives
in the same System Store, so this protects a leaked field or export, not a
compromised store.

Built-in read-only tools, each carrying the same requirement as its HTTP route:
`list_projects`, `get_project`, `project_logs`, `platform_status`,
`list_collections` and `read_collection` (at most 20 records). The database
tools are authorized against the caller's `project.view` for the Project named
in the call, then reach the Project through the Gateway's forwarder carrying
only the `database.inspect`/`database.read` authority the caller already holds,
so the Project runtime enforces it again. They cannot write.

Every tool call is shown in chat in the operator's words ("Reading logs for
site-a"), with its outcome, and refusals are shown as such. The activity is
saved with the reply, and `tool` stream events carry `id`, `label` and `status`.

### Changes need approval

`start_project`, `stop_project`, `restart_project` and `delete_project` never
run from the model's call. Once the caller's permission for that Project is
confirmed, the call becomes an approval request (`approval_required`) stored in
the System Store with the exact validated arguments, and the model is told it
has not run. The person decides with
`POST /zelavis/api/v1/runtime/assistant/threads/:threadId/approvals/:approvalId`
(`{decision: "approve" | "deny", confirm?}`); the thread reads back with its
approvals.

- Approval is a second gate, never a substitute: the caller's permission is
  checked again at approval, against the stored arguments, so a revoked
  permission stops the change and the model cannot alter what was approved.
- Only the requester, in that thread, can decide; anyone else gets `404`.
- The decision is a single compare-and-set out of `pending`, so a double click
  or replay runs the change once. It is marked `running` before anything runs,
  and a change that cannot be audited does not run.
- `delete_project` is irreversible: the target id must be typed out
  (`confirm`), and the card says so plainly.
- Requests expire after ten minutes, at most five wait per thread, and the
  outcome is added to the thread as a message.
- The dashboard card names the target by id, marks irreversible changes, and has
  no default action: nothing is focused and Approve is never the Enter key.

## Threat model

The model is untrusted, and so is everything it reads: Project records, logs
and any text another user could have written. What the design relies on, and
what it does not:

- **Authority is the caller's, checked at execution.** Prompt injection can make
  the model ask for anything; it cannot make a tool run that the caller may not
  run, and every change still needs a person's approval.
- **The approval names what will run.** The card is built from the stored,
  validated arguments, not from the model's words, and the change is pinned to
  the exact target (a Project recreated under the same name is refused).
- **Data reaching the provider is bounded.** The database tools read one fixed
  tenant, never the identity records that live beside it, at most 20 records at
  a time, and every result has credential-shaped values removed. That removal is
  defense in depth, not a boundary.
- **Model output cannot phone home.** The dashboard never loads an image a reply
  names (that would send what the URL encodes to its host with no click), and
  links open without the dashboard's window.
- **Cost and volume are bounded per caller:** 8,000 characters per message, 48,000
  characters of history per turn, 200 chats and 400 messages per chat, and 30
  turns per ten minutes with two at once (`429` with `retry-after`). The limiter
  is in memory, so it bounds one caller, not the installation's total spend.
- **Everything is auditable.** `GET /zelavis/api/v1/runtime/assistant/audit`
  (`server.assistant.audit`, held by owners through `*`) returns the trail newest
  first, 100 at most per page, with a cursor and filters for `principalId`,
  `tool` and `decision`. Arguments and reasons are redacted before they are
  written, records are kept for 90 days, and the dashboard shows them under
  Settings. Nothing can edit or write a record through the API.
- **Not covered:** a fleet-wide budget, and anything a provider does with what it
  is sent.

## Next Protocol Work

Real provider adapters should preserve the existing capability boundary while
adding:

- multi-provider selection and per-Project provider keys
- more mutating tools, and approvals for plugins
- run progress, logs, generated files, and error state
- retries, cancellation, branching, and richer thread metadata

assistant-ui's transport/runtime APIs can render these states, but Zelavis
remains authoritative. Provider credentials, persistence, authorization, and
tool execution must never move into dashboard components.
