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

## Next Protocol Work

Real provider adapters should preserve the existing capability boundary while
adding:

- multi-provider selection and per-Project provider keys
- mutating tools with human approval requests
- run progress, logs, generated files, and error state
- retries, cancellation, branching, and richer thread metadata

assistant-ui's transport/runtime APIs can render these states, but Zelavis
remains authoritative. Provider credentials, persistence, authorization, and
tool execution must never move into dashboard components.
