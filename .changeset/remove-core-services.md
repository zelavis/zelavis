---
"zelavis": major
---

Remove `coreServices`.

The name claimed the Platform had a second, privileged way to install services.
It did not: what the option held was the Platform's own subsystems, and every
member was either infrastructure or a policy switch. Services come from the
product-services folder and the registry endpoints, and only from there.

- `subsystems` on `zelavis(...)` carries `auth`, `database`, `fabric`,
  `storage`, `workloads`, and `site`. `site` replaces `website`, which was
  never a service — the placeholder it mounts is the frontend one, and the flag
  decides whether the installation owns `/` or lives under its root path.
- `frontend` absorbs `coreServices.dashboard`, and accepts a factory, an object
  (`factory`, `title`, `subtitle`, `devServerUrl`, `clientRoutes`), or `false`.
  The dashboard option predated frontends being a first-class concept; by the
  end every field it carried was about the frontend, and `clientRoutes` already
  fell back to the routes the frontend declared for itself.
- `runtimeSettingsStore` carries the settings store, which is a resource.
  Reaching it through the dashboard option meant an installation that turned
  its dashboard off also lost the Platform's own settings persistence.

Passing `coreServices` is refused with a message naming its replacement rather
than silently ignored: dropping it quietly would leave a caller believing they
had turned `auth` or `site` off while it was still running.

Also fixes subsystem option merging dropping `fabric` — the merge listed its
members by hand and omitted one, so an adapter and a host that both configured
the Fabric silently lost one of them.
