# @zelavis/ui

## 1.1.0-alpha.45

### Minor Changes

- 7fe8fb5: Add live Platform and Project registration controls, public Platform signup, and conditional human account access drawers. Render customer Projects, menus and actions from authenticated scoped grants, with default-closed signup and session invalidation after access changes.
- 7fe8fb5: Add password login and owner-enabled signup on native App site origins and Edge previews. Scope browser cookies and bearer routing to each Project and expose only the public Auth pages and self-session operations at site ingress.
- 7fe8fb5: Connect exact Project hostnames using DNS TXT proof. Platform owners can grant customers Project-scoped domain access. The dashboard, SDK and CLI share the same verification, activation and withdrawal operations.

### Patch Changes

- 7987555: A data-layout migration now replays document puts and deletions for live collections with uncompacted logs. It keeps their order, revisions, and times so time series can rebuild the same points. A compacted partition carries its final document state. The export is checked against the earlier engine's own reads, so a shard whose log reached that engine's export limit is refused instead of migrated with missing writes. A change-feed cursor issued before the migration is still refused; its consumer reads the feed from the start. Activating a schema now writes a collection's documents back only when the schema changes what they index, so an activation that changes no lens adds no change events.
- 5744998: A data-layout migration now keeps each document's version, creation and update times and expiry. Before, versions restarted at one, so a client holding a version read before the migration could later have a stale `expectedVersion` write accepted, once the document had been written that many times again, and overwrite newer data. Only the change history still restarts: a change-feed cursor issued before the migration is refused, and its consumer reads the feed again.
- Updated dependencies [7fe8fb5]
- Updated dependencies [7fe8fb5]
- Updated dependencies [9a5b41e]
- Updated dependencies [d4ff459]
- Updated dependencies [7987555]
- Updated dependencies [5744998]
- Updated dependencies [7fe8fb5]
- Updated dependencies [7fe8fb5]
- Updated dependencies [7fe8fb5]
- Updated dependencies [9a5b41e]
- Updated dependencies [7fe8fb5]
  - zelavis@2.0.0-alpha.45

## 1.1.0-alpha.44

### Patch Changes

- Updated dependencies [8a1210d]
  - zelavis@2.0.0-alpha.44

## 1.1.0-alpha.43

### Minor Changes

- 0f0457f: Persist cross-Tenant index refresh timestamps and failures across restarts. Add a native dashboard page for defining, listing, refreshing, querying, paging and dropping indexes through the shared Project API.
- 0f0457f: Activating a schema version now declares what it implies, safely: prose fields become searchable, numeric fields measures, a single reference an edge, and the new `GeometryField` (`coordinates: "wgs84"`, `resolution`) and `VectorField` (`model`, `modelVersion`, `dimension`, `metric`) the spatial index and the embedding. Nothing is inferred from a field that does not state it, hand-made declarations are kept, and the next activation replaces only what the previous one derived. Activation is a durable workflow: intent, apply and re-derive postings, publish in one transaction; one whose declarations stored documents break is refused (`SchemaActivationRefused`, 400) and leaves the collection as it was, and one cut off by a crash finishes when the database opens. The answer carries `activation: { applied, skipped, documents }`. Pending activations are listed and resumed through `tenant.schemas.pendingActivations`/`resumeActivations`, `GET|POST data/schemas/collections/activations[/resume]`, `client.data(p).schemas.activations()`/`resumeActivations()` and `zelavis data schema-activations`/`resume-schema-activations`. The dashboard's content-type builder and schema editor offer Geometry and Vector fields and report what an activation declared.

### Patch Changes

- 0f0457f: Spread cross-Tenant indexes across bounded immutable shard placements, with
  ordered page merging and query-bound continuations. Add geometry, vectors and
  non-unique composite declarations through HTTP, SDK, CLI and dashboard forms.
  Persist re-derivation markers and refuse queries after an interrupted rebuild
  until refresh completes, instead of returning stale or incomplete entries.
- Updated dependencies [0f0457f]
- Updated dependencies [0f0457f]
- Updated dependencies [0f0457f]
- Updated dependencies [0f0457f]
- Updated dependencies [0f0457f]
- Updated dependencies [4f6719c]
- Updated dependencies [0f0457f]
- Updated dependencies [d57e446]
- Updated dependencies [0f0457f]
- Updated dependencies [0f0457f]
- Updated dependencies [4f99eca]
- Updated dependencies [0f0457f]
- Updated dependencies [4f6719c]
- Updated dependencies [0f0457f]
- Updated dependencies [4326e6b]
- Updated dependencies [f88cb26]
- Updated dependencies [bf41f4b]
- Updated dependencies [0f0457f]
- Updated dependencies [0f0457f]
- Updated dependencies [0f0457f]
- Updated dependencies [ac78c91]
- Updated dependencies [b2e08f1]
- Updated dependencies [0f0457f]
- Updated dependencies [4f6719c]
- Updated dependencies [0f0457f]
- Updated dependencies [0f0457f]
- Updated dependencies [0f0457f]
- Updated dependencies [0f0457f]
- Updated dependencies [0f0457f]
- Updated dependencies [0f0457f]
- Updated dependencies [0f0457f]
- Updated dependencies [0f0457f]
- Updated dependencies [0f0457f]
- Updated dependencies [ec60fac]
- Updated dependencies [0f0457f]
- Updated dependencies [0f0457f]
- Updated dependencies [0f0457f]
- Updated dependencies [0f0457f]
- Updated dependencies [0f0457f]
- Updated dependencies [0f0457f]
- Updated dependencies [0f0457f]
- Updated dependencies [0f0457f]
- Updated dependencies [b7e5333]
- Updated dependencies [362ae43]
- Updated dependencies [0f0457f]
- Updated dependencies [0f0457f]
- Updated dependencies [4f6719c]
  - zelavis@2.0.0-alpha.43

## 1.1.0-alpha.42

### Patch Changes

- Updated dependencies [65e65af]
  - zelavis@2.0.0-alpha.42

## 1.1.0-alpha.41

### Patch Changes

- Updated dependencies [e3cd867]
  - zelavis@2.0.0-alpha.41

## 1.1.0-alpha.40

### Patch Changes

- Updated dependencies [d07cc80]
  - zelavis@2.0.0-alpha.40

## 1.1.0-alpha.39

### Patch Changes

- c038a76: The terminal fills its window: it was fitted to nine columns because the island holding it was an inline element, which also made typed text hard to follow. API keys are now a section of Server → Access with presets (Debug read-only, Operator, Project client), one-time display, rotation and revocation. A new read-only diagnostic, `zelavis debug processes` (`client.debug.processes`, `GET /runtime/debug/processes`, permission `server.debug.read`), lists the Platform account's Zelavis processes with secrets removed and flags a command running more than once side by side.
- Updated dependencies [c038a76]
- Updated dependencies [84b8e68]
- Updated dependencies [5745c67]
  - zelavis@2.0.0-alpha.39

## 1.1.0-alpha.38

### Patch Changes

- Updated dependencies [acf44d8]
- Updated dependencies [c8c7ff0]
  - zelavis@2.0.0-alpha.38

## 1.1.0-alpha.37

### Minor Changes

- 659cb13: The dashboard is now built with Fuzor. It is the same dashboard to use: every page is there and every page is now native: the Database workspace uses three grid libraries with draft recovery, Content Studio, Workloads, Storage and Media, the Marketplaces, Server and Fabric, the Assistant, Settings and the first-run setup were rebuilt, and **Update now** is in the shell on every page. Uploads from the dashboard keep their label, alt text and purpose (the Gateway removed them before). One build now mounts at any root path (`/zelavis`, `/admin`, `/`), the dashboard calls the Platform it runs in directly rather than over a guessed address, and the package ships only built output that needs nothing installed beside it. The previous React dashboard stays in the repository as `@zelavis/ui-legacy`, private and no longer shipped. Development uses the Fuzor checkout next to the repository when there is one, and the pinned npm release otherwise.

### Patch Changes

- Updated dependencies [3548515]
- Updated dependencies [659cb13]
- Updated dependencies [16739cd]
  - zelavis@2.0.0-alpha.37
