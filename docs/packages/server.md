# @zelavis/server

`@zelavis/server` defines the shared server service contract and Web-first runtime surface used across Zelavis packages.

## Current role

Packages expose server services through a shared contract, and adapters mount or embed the resolved runtime.

## Core ideas

- packages export services with `defineService(...)`
- services can compose nested services
- `zelavisServer(...)` resolves routes once and exposes reusable runtime handlers
- adapters adapt the resolved runtime to framework-specific shapes

## Runtime surfaces

Current runtime surfaces include:

- `fetch(request)`
- `plain({ ... })`
- `dispatch(request)`

## Why it matters

This package is the transport boundary that keeps domain packages mountable without baking framework logic into each package.

## Related docs

- [zelavis](./zelavis.md)
- [Node adapter](../adapters/node.md)
