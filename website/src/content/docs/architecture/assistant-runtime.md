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
```

Threads may carry a `projectId`. This lets the dashboard present Assistant
navigation as Projects -> project -> Chats and enforce the same project access
boundaries later.

## Implemented Today

- persistent threads and messages through the System Store
- project-scoped thread listing
- desktop chat workspace and compact mobile slide workspace
- structured dashboard navigation actions in Assistant replies
- a replaceable responder contract
- a deterministic built-in responder named `zelavis-local-router`

The built-in responder is not a language model. It recognizes a small set of
supported platform intents and returns text plus safe dashboard links.

## Next Protocol Work

Real provider adapters should preserve the existing capability boundary while
adding:

- streamed message events
- model and agent provider selection
- typed tool calls backed by Zelavis endpoints
- permission checks and human approval requests
- run progress, logs, generated files, and error state
- retries, cancellation, branching, and richer thread metadata

assistant-ui's transport/runtime APIs can render these states, but Zelavis
remains authoritative. Provider credentials, persistence, authorization, and
tool execution must never move into dashboard components.
