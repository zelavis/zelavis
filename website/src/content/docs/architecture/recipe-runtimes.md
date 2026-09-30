---
title: Recipe Runtimes and Managed Apps
description: How a Project recipe ships its own runtime, why it is frozen into each Project, and who may load it.
---

A **Project recipe** is a service with `kind: "app"`: the unit a Project is
created from. `@zelavis/app` is the official one and ships with the Platform.
Others, such as `@zelavis/wordpress`, are ordinary npm packages that reach an
installation through the [marketplace allow-list](./marketplace-allowlist.md).

## A recipe can bring its own runtime

A Zelavis App runs on the Platform's own engine, so its recipe only carries
identity, menu and defaults. A recipe for other software (WordPress and the like)
has to provision and supervise real processes. It declares that in its
`package.json`:

```json
{
  "name": "@zelavis/wordpress",
  "zelavis": {
    "kind": "app",
    "project": {
      "runtimeKinds": ["native"],
      "runtime": "./dist/runtime.js",
      "managed": { "adminTitle": "WordPress Admin", "adminPath": "/wp-admin/" }
    }
  }
}
```

`runtime` is a module inside the package's `dist` that exports
`createProjectRuntime(context)`. It is written against the public
`zelavis/adapters/project-runtime` API. The Platform knows nothing about
WordPress. It loads whatever the recipe names.

## Frozen into the Project

When a Project is prepared, the recipe package is copied into
`<project>/.zelavis/recipe/package`. Only `package.json`, `dist` and `dashboard`
are copied, and the copy is locked by a content digest recorded in the Project's
lock. On every start the Platform verifies the digest, name and version and
refuses code that was modified or does not match.

So updating the recipe package on the Platform never changes what an existing
Project runs. Moving a stopped Project to a newer recipe is an explicit
**recipe upgrade**, and the new copy is frozen and swapped in only when complete.
A failed upgrade leaves the Project as it was. The Project's data is untouched.

## Who may load a recipe's runtime

A recipe runtime is host code. It starts and stops processes with the Platform's
authority. That is exactly what an installed npm package must not be able to do
by default, so a host loads one only from a recipe it trusts. Any one of these
makes it trusted:

- the allow-list entry says `projectRuntime: true` (a vouch made when the list
  is signed, for services the Zelavis project maintains);
- the package is in the operator's own development checkout of
  `zelavis-services`;
- the operator named it in the host's `projects.recipeRuntimes` option.

A recipe that is not trusted can still declare a runtime. The Platform refuses to
run it and says why.

## Managed apps

A recipe with `zelavis.project.managed` is a **managed app**. Its Project is not
built on Zelavis Auth or Database, so the dashboard gives it hosting-style
controls (Domains, Files, Logs, Updates) plus the app's own admin entry, instead
of the Zelavis-native navigation. The recipe says what that entry is called and
where it lives. The dashboard renders this and does not recognise any recipe by
name.

## Versions

The package version is the recipe version. `@zelavis/wordpress@7.1.2` installs
WordPress 7.1.2, and `7.1.0` installs WordPress 7.1. The exact WordPress archive
digest is pinned inside the package, and the runtime refuses any other bytes
before unpacking, so what a Project downloads is fixed by the recipe version, not
by the download server.

## Related

- [Platform OS and Project Recipes](./platform-project-recipes.md)
- [Marketplace Allow-List](./marketplace-allowlist.md)
- [Execution Backends and Traffic](./execution-backends.md)
