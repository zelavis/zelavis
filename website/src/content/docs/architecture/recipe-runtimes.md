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

## Effect runtime drivers

Project lifecycle orchestration, the local driver router, Node/server frontend
runtimes, and the native WordPress recipe use Effect v4 programs. The public
runtime driver protocol still presents Promises. `defineEffectProjectRuntime`
from `zelavis/adapters/project-runtime` presents a native Effect driver through
that protocol; internal Platform callers retain its Effect implementation, so
interruption reaches coordination and cleanup finalizers.

A failed or interrupted startup stops the processes it acquired. A failed or
interrupted recipe preparation restores the previous frozen artifact and host
descriptor. Deletion persists its tombstone before cleanup, records each
completed participant, and keeps interrupted cleanup visible and retryable.
Effect permits and Deferred results coordinate callers within one process;
persisted checkpoints and Fabric fencing still own restart recovery and
placement authority.

Frozen runtime modules resolve `effect` and `zelavis` from the Platform. Recipes
must declare them as host-provided peers rather than installing another copy.
No Project runtime gains host package authority through Effect.

## Effect recipe authoring contract

The public `zelavis/recipe` subpath provides an initial runtime-neutral contract
for recipes written with Effect v4. It is available for authoring and validation;
A recipe either brings a whole runtime module (the model above) or, as `@zelavis/wordpress`
does, brings only phases and lets the Platform's `createRecipeProjectRuntime` run them. A
package declares this contract's manifest as
`zelavis.project.install` in its `package.json`, validated when the package is loaded
(an invalid one fails the load, naming the package). OCI execution remains planned.

`parseRecipeManifest` validates contract 1 metadata: named methods, bounded host
requirements, declared ports and software releases with HTTPS archives, SHA-256
digests and download size limits. JS methods name a relative module entry. OCI
methods declare digest-pinned images; declaring an image does not enable execution.
Unknown fields, unsupported contracts, duplicate identities and mutable image tags
are refused. The returned manifest is an immutable snapshot.

Software versions belong to verified recipe metadata independently of the npm
recipe revision. `selectRecipeMethod` picks the first method the supplied host
capabilities can satisfy, or refuses an unavailable explicit choice.
`selectRecipeSoftware` takes the requested version, which must be offered, or the newest.

Creating a Project from a recipe that declares `install` makes both choices once and
locks them in the Project's recipe lock (`install: { method, driver, requires, software }`):
`projects create --method ID --software-version V`, `client.projects.create({ method,
softwareVersion })`, `POST /runtime/projects`, and two pickers in the dashboard's create form
(`GET /runtime/project-recipes` and the CLI `projects recipes` list what is on offer). With
no choice named the Platform locks the first method this host can run and the newest
software. The host's capabilities are the drivers it has (JavaScript today; OCI has no driver)
and the requirements it has or can install through an approved package set. A host that cannot
prove its capabilities refuses such a recipe instead of guessing. A start or restart checks the lock
and refuses, naming what is missing, when the host no longer provides the method; it never
selects another. A recipe upgrade keeps the choice when the newer recipe still offers that
method and software version, and is refused otherwise.

Once its start phase has returned a process plan, `startProcessPlan` runs it through the Agent's
process contract: processes start in dependency order, each only after its dependencies' ports
accept connections (independent ones together, at most four at a time), executables and ports
come from the host's tables and never from the plan's text, the environment is exactly what the
plan names, and secret references are resolved at the last moment. A process that is not ready in
time, or exits first, fails the start after everything already started is stopped; one that exits
later is reported and not restarted; stopping goes dependents first; interruption stops what was
started.

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

### Upgrading a Project to a recipe with a different layout

An application is a folder of files and a database directory, and a recipe's upgrade does not
convert them. A recipe whose layout differs from an earlier version of itself says how to take
the earlier one over in its manifest (`adopt`): the earlier state file that marks the layout, the
folders to rename (`move`), the values to carry over from that file (the ports the existing
configuration already names, the database password, the socket identity), empty marker files to
create, and generated leftovers to discard. Upgrading a stopped Project to such a recipe then:

1. validates the earlier state and writes a journal before anything moves;
2. renames the folders (atomic and instant whatever the database's size; nothing is read,
   copied or rewritten, and symbolic links are refused), writes the carried-over password to the
   Project's secrets and creates the markers;
3. keeps the Project's address, because the ports are carried over;
4. lets the recipe's own `install` resume over what is there (it regenerates configuration at
   the new paths and skips what already exists);
5. keeps the earlier state until the Project runs on the new layout. If anything fails first,
   or the upgrade cannot be recorded, every folder is moved back and what was created is
   removed, so the earlier recipe finds its Project as it left it; the interrupted case resumes.

### Upgrading a running Project

A running Project whose new recipe keeps the same layout upgrades without stopping. The
Platform stages the new recipe beside the running one, runs its `start` phase to get the new
process plan, and reconciles that plan against the running processes by fingerprint:

- a process whose launch (executable, arguments, directory, environment) and configuration are
  unchanged is **kept** and never touched;
- a process whose plan lists `config` files and an `update` signal (for example Nginx `SIGHUP`,
  PHP-FPM `SIGUSR2`) and whose only change is those files is **reloaded** in place;
- a process whose launch changed, or that had exited, is **replaced**, and new ones are added,
  in dependency order, each waiting for readiness before its dependents are touched.

A durable journal records the upgrade, so after a crash the physical state decides whether the
Project is on the previous or the target recipe. Any failure (an unready process, a failed
phase, a commit that cannot be recorded) reconciles back to the previous plan. Proven with real
processes: a running Project upgraded through the manager with no failed request and an
unchanged database PID, and the real WordPress recipe (Nginx, PHP-FPM, MariaDB) switching to a
changed web configuration under continuous traffic with all three PIDs unchanged.

Managed apps (WordPress, and any other recipe that declares `managed`) take the same path in one
transaction with their Zelavis integration: the processes are reconciled first and can be put
back, the integration host's handover is the single commit point, and a crash is settled from
the host's journal, so the processes, their configuration and the integration are always on the
same recipe. A recipe upgraded while its Project is stopped runs its `install` phase the next
time the Project starts. Nothing in this is specific to one application.

### Moving data to a new place

A recipe can place its application data by name, in the manifest (`directories`: a name and a
path below the recipe's root), and reads the current place from `context.directories.named` in
its phases, never by joining the path itself. When a newer recipe names another path, a running
Project is upgraded with its data where it is (the database is not touched, so it is not
restarted), and the layout map in the Project's recipe state remembers the old place. The next
time the Project starts from a stop, the data is moved to the new place with one atomic rename
(an existing destination that holds data is never overwritten; the data then stays where it is
and keeps working), and the install phase runs again so configuration names the new place. A
crash in between is finished by the next start, because the physical state decides.

### Setup values

Some applications cannot finish their own setup without values the Platform generated: Joomla's
installer asks for the database's address, name, user and password. A recipe declares them in the
manifest (`setup`: an id, a label and a template over `{ports.NAME}`, `{dir.NAME}`, `{secret.NAME}`,
`{root}`, `{sockets}` and `{user}`; a template naming something the recipe does not declare is refused
when the recipe loads). `zelavis projects setup <id>`, `client.projects.setup(id)` and
`GET /zelavis/api/v1/runtime/projects/:projectId/setup` list them with `project.view`; a value that
contains a secret carries none. `--reveal`, `client.projects.revealSetup(id)` and
`POST .../setup/reveal` return the secrets too, need `project.setup.reveal`, and are recorded (the
Project, the caller and the value ids, never the values) in the System Store namespace
`projects.setup-audit.v1`, capped at 500 records and 90 days; a reveal that cannot be recorded is not
given. The dashboard does not show these values yet.

### Replacing a serving process

When a newer recipe changes how a process is launched (not only its configuration), that process is
replaced, which would otherwise show as failed requests. While a replacement runs, the Platform's
gateway holds public requests for the Project at its ingress (`ingressReady`) and releases them when
the new process is ready, after first giving requests already inside the Project 300 ms to finish. A
request waits at most 15 seconds. Reloads and kept processes never close the gate. The gate holds
requests; it cannot keep a database available while it restarts, so a replaced database is still a
short pause for the requests that need it.

### Three managed recipes

WordPress (Nginx, PHP-FPM, MariaDB, generated credentials), DokuWiki (Nginx and PHP-FPM, no database,
no credentials) and Joomla (like WordPress, whose installer needs the generated values) are managed
recipes on this path, with no code in the Platform that names any of them. DokuWiki and Joomla exist to
keep that true. Host packages are fixed named sets (`wordpress-stack`, `php-stack`, `mariadb-server`); a
recipe lists the sets it needs.

Limits today: a replaced process is covered by the ingress gate for requests, but a database whose launch changed still pauses what needs it; a layout
move (adoption of an earlier layout) still needs the Project stopped, because a running
database directory cannot be renamed, so the dashboard **Upgrade** action,
`projects upgrade <id> --restart`, `client.projects.upgrade(id, { restart: true })` and
`{"restart": true}` over HTTP stop, upgrade and start again; and a new recipe that needs
requirements or commands the Project does not already hold is refused on the live path and
rolled back. Recipe upgrades never change the application's own software.

WordPress uses this: an existing WordPress Project (its site, uploads and database) upgrades to
the current recipe with its address, content and admin login unchanged. The application's own
software is not updated; WordPress updates itself from wp-admin.

### The Node RecipeHost and the phase process

The Node implementation (`adapters/_recipe-host.ts`) enforces what the interface only
describes. Every path is relative to the Project directory; absolute paths, `..` and any
symbolic link along the way are refused, and files are written through a temporary file
opened with `O_NOFOLLOW`. A command runs only from a table of absolute executables the host
builds from the recipe's declared requirements, with no shell, a clean environment (none of
the host's variables), a deadline, bounded output, and its whole process group killed when
the deadline passes or the phase is interrupted. A download must be https (redirects only to
https, at most three), is bounded by the manifest's size, and is kept only if its SHA-256
equals the pinned digest. `extract` unpacks `.tar.gz` into a staging directory, refuses names
that climb or are absolute, keeps nothing but plain files and directories, and moves the
result into place only when it is whole. Secrets are generated once into a private directory
outside the Project, travel only as references, and are replaced by `[secret]` in anything a
command prints or a progress message carries. A conformance suite
(`test/fixtures/recipe-host-conformance.mjs`) holds any adapter to the same behavior.

A phase never runs inside the Platform. `runRecipePhase` starts a fresh Node for each phase
(as the Project's OS user when given one), with a clean environment and Node's permission
model on: the process may write only to the Project directory and its secrets directory and
read only those, the recipe's own folder and the packages it loads. The Platform sends one
request and receives progress and one result over a private descriptor; what the recipe prints
is only a log, and the parent validates the plan or path it receives against the manifest's
own names, because the recipe shares that descriptor. This confines files Node itself
touches. Commands a recipe declared start from inside the phase and can do what the OS user
can do; the boundaries that remain are the allow-list of official recipes, the OS user, and
the host-operation broker. Network access, CPU and memory are limited only by the deadline and
output caps. They are connected to Project creation: the recipe runtime (`createRecipeProjectRuntime`)
resolves the executables for the locked method's requirements, allocates and keeps the ports,
runs `install` once per Project and `start` each time in a phase process (as the Project's OS
user), supervises the returned plan, and after a Platform restart asks the recipe for its plan
again and adopts the processes the Agent kept running. Executables are found by the host from a
requirement catalogue (`nginx`, `php-fpm`, `mariadb`, `node`): on PATH or the usual sbin
directories, or Homebrew's prefix; a missing one is installed through Homebrew on macOS and
reported with how to approve the package set on Linux.

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
