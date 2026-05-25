---
title: Service Marketplace Catalog
---
Zelavis separates service discovery from service activation.

- **Catalog entries** describe services the Marketplace can show.
- **Registry entries** describe services the runtime knows about.
- **Registry state** decides whether a known service is installed.

That keeps the Marketplace flexible without making every discovered service executable by default.

## Catalog Contract

Use `defineServiceCatalogEntry(...)` for one service and `defineServiceCatalog(...)` for a list:

```ts
import { defineServiceCatalog } from "zelavis/service";

export const marketplaceCatalog = defineServiceCatalog([
  {
    name: "@zelavis/ecommerce",
    package: "@zelavis/ecommerce",
    publisher: "zelavis",
    source: "official",
    title: "Ecommerce",
    summary: "Official commerce service for Zelavis.",
    compatibility: {
      zelavis: "^1.0.0",
      service: "^1.0.0",
    },
    tags: ["commerce", "orders", "products"],
  },
  {
    name: "@zelavis/ecommerce-stripe",
    package: "@zelavis/ecommerce-stripe",
    publisher: "zelavis",
    source: "official",
    extends: "@zelavis/ecommerce",
    compatibility: {
      zelavis: "^1.0.0",
      parentService: "^1.0.0",
    },
    tags: ["payments"],
  },
]);
```

## Fields

- `name`: runtime service name, matching the service definition.
- `package`: package specifier users install or import.
- `publisher`: Marketplace publisher handle.
- `source`: `official` or `community`.
- `title`, `summary`, `description`: display metadata.
- `version`: optional published package version.
- `reviewStatus`: `official`, `reviewed`, `unreviewed`, or `blocked`.
- `verified`: whether the publisher/package has been verified by the Marketplace.
- `extends`: parent service name for child services. When present, Marketplace metadata applies to that parent service's child marketplace instead of the main Marketplace.
- `compatibility`: version ranges for Zelavis, the service package, or the parent service.
- `links`: homepage, repository, documentation, or issue tracker URLs.
- `license`: package license label.
- `tags`: searchable Marketplace tags.

Official catalog entries default to `reviewStatus: "official"` and `verified: true`.
Community catalog entries default to `reviewStatus: "unreviewed"` and `verified: false`.

## Where Community Services Should Live

Community service source code should not live inside the main `zelavis/zelavis` monorepo.

Recommended layout:

- `zelavis/zelavis`
  - core runtime
  - dashboard
  - official first-party services under `services/*`
- `zelavis/service-catalog`
  - reviewed Marketplace metadata
  - package names, publishers, links, compatibility, review status
- author-owned repositories
  - actual community service source code
  - published packages on npm or another package registry

This keeps the core repo maintainable, keeps community ownership clear, and gives the Marketplace a trust boundary. A community service can be discoverable through catalog metadata without becoming part of the core codebase.

The catalog can start as a simple versioned JSON or TypeScript package. Later it can become a signed service-backed Marketplace without changing the runtime service contract.

## From catalog to runtime

Catalog entries are not executed directly. A host activates a service through runtime registry state:

```ts
{
  name: "@acme/search",
  specifier: "https://cdn.example.com/acme-search.mjs",
  status: "installed",
  source: "community",
}
```

The `specifier` points to the service's ESM module entry point. That module should export a `defineService(...)` result as `default`, `service`, or as the module object itself.

For local testing, `examples/plugin-basic` builds a real service package at `examples/plugin-basic/dist/example-basic.zip`. Run `pnpm --filter @zelavis/example-plugin-basic package`, select that ZIP in Marketplace, and the Node adapter will unpack it into `.zelavis/services`, read `zelavis.service.json`, derive the service name from the module definition, then activate it without restarting the server.

Marketplace install/upload flows should:

1. create or update registry state
2. call the active host's service activation controller
3. show whether the host reports `active` or `pending`

On Node, uploaded ZIP packages resolve through the Node adapter package installer and uploaded ESM specifiers resolve through the Node adapter importer. On Cloudflare, activation should go through a Worker boundary such as `createCloudflareDispatchServiceActivation(...)`; a future Cloudflare package installer can map the same ZIP contract to Worker/package deployment instead of local disk.
