---
"zelavis": minor
"@zelavis/ecommerce": minor
---

Unified plugin operations across HTTP, JS SDK, and CLI with typed contracts:

- Declarative plugin operations via `zelavis.operations.create` exposed at `/zelavis/api/v1/plugins/<namespace>/<resource>`, `client.plugins.<namespace>.<resource>.<action>()`, and `zelavis plugins <namespace> <resource> <action>`.
- CLI ergonomics: support for `--data <json>`, `--data-stdin`, `--file -` (stdin), and `--flag=value` syntax.
- Migrated `@zelavis/ecommerce` endpoints to declared operations with OpenAPI specs and typed `EcommercePluginClient` augmenting `PluginApiRegistry`.
