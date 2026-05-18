---
title: Plugin Marketplace Catalog
---
Zelavis separates plugin discovery from plugin activation.

- **Catalog entries** describe plugins the Marketplace can show.
- **Registry entries** describe plugins the runtime knows about.
- **Registry state** decides whether a known plugin is installed.

That keeps the Marketplace flexible without making every discovered plugin executable by default.

## Catalog Contract

Use `definePluginCatalogEntry(...)` for one plugin and `definePluginCatalog(...)` for a list:

```ts
import { definePluginCatalog } from "zelavis/plugin";

export const marketplaceCatalog = definePluginCatalog([
  {
    name: "zelavis-ecommerce",
    package: "@zelavis/ecommerce",
    publisher: "zelavis",
    source: "official",
    title: "Ecommerce",
    summary: "Official commerce plugin for Zelavis.",
    compatibility: {
      zelavis: "^1.0.0",
      plugin: "^1.0.0",
    },
    tags: ["commerce", "orders", "products"],
  },
  {
    name: "stripe",
    package: "@zelavis/ecommerce-stripe",
    publisher: "zelavis",
    source: "official",
    extends: {
      plugin: "zelavis-ecommerce",
      extensionPoint: "payments",
    },
    compatibility: {
      zelavis: "^1.0.0",
      parentPlugin: "^1.0.0",
    },
    tags: ["payments"],
  },
]);
```

## Fields

- `name`: runtime plugin name, matching the plugin definition.
- `package`: package specifier users install or import.
- `publisher`: Marketplace publisher handle.
- `source`: `official` or `community`.
- `title`, `summary`, `description`: display metadata.
- `version`: optional published package version.
- `reviewStatus`: `official`, `reviewed`, `unreviewed`, or `blocked`.
- `verified`: whether the publisher/package has been verified by the Marketplace.
- `extends`: child plugin target, such as ecommerce payments.
- `compatibility`: version ranges for Zelavis, the plugin package, or the parent plugin.
- `links`: homepage, repository, documentation, or issue tracker URLs.
- `license`: package license label.
- `tags`: searchable Marketplace tags.

Official catalog entries default to `reviewStatus: "official"` and `verified: true`.
Community catalog entries default to `reviewStatus: "unreviewed"` and `verified: false`.

## Where Community Plugins Should Live

Community plugin source code should not live inside the main `zelavis/zelavis` monorepo.

Recommended layout:

- `zelavis/zelavis`
  - core runtime
  - dashboard
  - official first-party plugins under `plugins/*`
- `zelavis/plugin-catalog`
  - reviewed Marketplace metadata
  - package names, publishers, links, compatibility, review status
- author-owned repositories
  - actual community plugin source code
  - published packages on npm or another package registry

This keeps the core repo maintainable, keeps community ownership clear, and gives the Marketplace a trust boundary. A community plugin can be discoverable through catalog metadata without becoming part of the core codebase.

The catalog can start as a simple versioned JSON or TypeScript package. Later it can become a signed service-backed Marketplace without changing the runtime plugin contract.

## From catalog to runtime

Catalog entries are not executed directly. A host activates a plugin through runtime registry state:

```ts
{
  name: "acme-search",
  specifier: "https://cdn.example.com/acme-search.mjs",
  status: "installed",
  source: "community",
}
```

The `specifier` points to the plugin's ESM module entry point. That module should export a `definePlugin(...)` result as `default`, `plugin`, or as the module object itself.

For local testing, `examples/plugin-basic` builds a real plugin package at `examples/plugin-basic/dist/example-basic.zip`. Run `pnpm --filter @zelavis/example-plugin-basic package`, select that ZIP in Marketplace, and the Node adapter will unpack it into `.zelavis/plugins`, read `zelavis.plugin.json`, derive the plugin name from the module definition, then activate it without restarting the server.

Marketplace install/upload flows should:

1. create or update registry state
2. call the active host's plugin activation controller
3. show whether the host reports `active` or `pending`

On Node, uploaded ZIP packages resolve through the Node adapter package installer and uploaded ESM specifiers resolve through the Node adapter importer. On Cloudflare, activation should go through a Worker boundary such as `createCloudflareDispatchPluginActivation(...)`; a future Cloudflare package installer can map the same ZIP contract to Worker/package deployment instead of local disk.
