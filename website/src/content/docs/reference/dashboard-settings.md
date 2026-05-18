---
title: Dashboard Settings
---
Zelavis exposes runtime-editable dashboard settings through:

```txt
GET /zelavis/api/v1/dashboard/settings
PATCH /zelavis/api/v1/dashboard/settings
```

When `rootPath`, API prefix, or API version are customized, the mounted path changes with them.

## Current response shape

`GET` returns:

```ts
interface ZelavisDashboardSettings {
  rootPath: string;
  pendingRootPath?: string;
  apiBasePath: string;
  theme: "light" | "dark" | "auto";
  pageBuilderEnabled: boolean;
  preferences: {
    content?: {
      pinnedTypes?: string[];
      labels?: Record<string, string>;
    };
    media?: {
      orderedPaths?: string[];
    };
  };
  persistence: "runtime" | "read-only";
  editable: {
    rootPath: boolean;
    theme: boolean;
    pageBuilder: boolean;
  };
  restartRequired: boolean;
}
```

## Current update shape

`PATCH` accepts any subset of:

```ts
interface ZelavisDashboardSettingsUpdate {
  rootPath?: string;
  theme?: "light" | "dark" | "auto";
  pageBuilderEnabled?: boolean;
  preferences?: {
    content?: {
      pinnedTypes?: string[];
      labels?: Record<string, string>;
    };
    media?: {
      orderedPaths?: string[];
    };
  };
}
```

The endpoint returns the full normalized settings object after the update is written.

## Notes

- `rootPath` updates are stored as pending settings and set `restartRequired: true` until the runtime restarts with the new mounted path.
- `pendingRootPath` only appears when the stored root path differs from the active mounted root path.
- `pageBuilderEnabled` is only editable when the website core service is available.
- `preferences.content.pinnedTypes` keeps editor-facing content types pinned and ordered at the top of the dashboard Content screen.
- `preferences.content.labels` stores editor-facing labels while the lower-level database collection slug stays unchanged.
- `preferences.media.orderedPaths` persists Media Gallery ordering through the runtime-backed dashboard settings store.
- Persistence depends on the configured settings store. In-memory fallback behavior is runtime-local.

## Related docs

- [First Runtime](../getting-started/first-runtime.md)
- [zelavis package](../packages/zelavis.md)
- [Node adapter](../adapters/node.md)
