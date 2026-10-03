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
A failed upgrade restores the previous frozen recipe and host descriptor.
Custom runtime modules load from verified digest-specific copies under
`<project>/.zelavis/recipe-modules`, including their relative imports, so a
Platform process cannot reuse the old runtime when upgrading. The Project's
data is untouched.

The host records the locked recipe before provisioning begins, so custom
cleanup can still run after a failed preparation and a Platform restart.

A Project pending deletion cannot be started or upgraded: cleanup may already
have removed resources. Its card shows the failed cleanup step and offers
**Retry deletion** to finish removal. Early provisioning failure before a
host descriptor exists can still be deleted; genuine cleanup failures remain
visible and retryable.

## Who may load a recipe's runtime

A recipe runtime is host code. It starts and stops processes with the Platform's
authority. That is exactly what an installed npm package must not be able to do
by default, so a host loads one only from a recipe it trusts. Any one of these
makes it trusted:

- the allow-list entry says `projectRuntime: true` (a vouch made in the list
  served over HTTPS from zelavis.com, for services the Zelavis project maintains);
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

The npm package version identifies the recipe revision. Its software release and
archive digest are pinned independently inside that package. A provisioning fix
can therefore keep installing the same WordPress release. The runtime verifies
the digest before unpacking, and each Project keeps its frozen recipe revision.

## Effect recipe authoring contract

The public `zelavis/recipe` subpath provides an initial runtime-neutral contract
for recipes written with Effect v4. It is available for authoring and validation;
package admission and Project execution still use the runtime-module model above.
The JS recipe driver, Node host layer and OCI execution remain planned.

`parseRecipeManifest` validates contract 1 metadata: named methods, bounded host
requirements, declared ports and software releases with HTTPS archives, SHA-256
digests and download size limits. JS methods name a relative module entry. OCI
methods declare digest-pinned images; declaring an image does not enable execution.
Unknown fields, unsupported contracts, duplicate identities and mutable image tags
are refused. The returned manifest is an immutable snapshot.

Software versions belong to verified recipe metadata independently of the npm
recipe revision. `selectRecipeMethod` picks the first method the supplied host
capabilities can satisfy, or refuses an unavailable explicit choice. Integration
must lock the selected method ID at creation; a Project start must use that lock.

`defineRecipe` describes Effect `install` and `start` phases, with optional `stop`,
`upgrade`, `backup` and `remove`. Phases request the `RecipeHost` service, which
defines Project-local file access, bounded verified downloads, extraction, declared
executable calls, opaque secret references and progress events. The host owns
execution scopes and supervision; phases return values rather than daemonizing.
`parseProcessPlan` validates declared executables and ports, bounded arguments and
readiness deadlines, unique process names and acyclic dependencies before
supervision. Credential references can be passed in arguments and environment
values without storing the credential itself in the plan.

Concrete host layers must enforce path and symlink confinement, executable
restrictions, output limits, cancellation and owner-only secret persistence.
The service interface itself does not enforce those restrictions and is not a
sandbox for arbitrary JavaScript. Privileged package installation belongs to the
Platform's audited host-operation broker, outside RecipeHost.

System installations and updates configure `zelavis-host-agent.service`, a separate
root Agent accepting only operation catalog/submit/get. Its endpoint and token are
root-owned and accessible only to the dedicated Platform group. The Platform uses
`ZELAVIS_HOST_OPERATIONS_ENDPOINT`; the unprivileged Project process Agent remains
separate. The root Agent uses systemd-delegated cgroup v2 containment and refuses
arbitrary process commands.

Recipes may declare bounded `zelavis.project.hostPackages` sets such as
`["wordpress-stack"]`. These are fixed operations, never supplied package names or
commands. Project creation accepts `installHostPackages: true` through HTTP/SDK,
`--install-host-packages` through CLI, and an explicit dashboard checkbox. It
requires the broker's `server.packages.install` permission independently of
`projects.create`; without approval, the recipe only uses existing dependencies.

The package operation preserves existing host services, suppresses APT-triggered
starts only in its process tree, and disables only newly introduced units. Its
persistent policy delegates normal calls to the recorded original, so cancellation
cannot leave a global deny policy. Complete uninstall restores the owned policy
while retaining operator edits and shared packages.

## Related

- [Platform OS and Project Recipes](./platform-project-recipes.md)
- [Marketplace Allow-List](./marketplace-allowlist.md)
- [Execution Backends and Traffic](./execution-backends.md)
