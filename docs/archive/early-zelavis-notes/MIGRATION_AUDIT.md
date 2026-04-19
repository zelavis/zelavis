# Early Zelavis Migration Audit

This audit turns the archived prototype notes into an actionable migration plan. The archive preserves useful ideas, but the current Zelavis repository remains the source of truth for package shape, public API style, naming, and scope.

## Decision Legend

- **Take**: Carry the idea into active Zelavis work with only normal implementation design.
- **Adapt**: Keep the underlying idea, but redesign it around current Zelavis package boundaries.
- **Reject**: Do not port. Keep only as historical context.
- **Defer**: Valuable, but not needed for the near-term commerce/auth/server foundation.

## Principles

- Keep `@zelavis/server` as the shared transport contract. Domain packages should expose services; integrations should mount them.
- Keep domain packages framework-agnostic. Runtime-specific code belongs in integrations or provider packages.
- Keep persistence behind repository-style contracts. Do not make one storage engine the center of the project.
- Prefer small package surfaces over one central runtime object.
- Avoid adding heavy dependencies until a specific package needs them.
- Do not copy archived APIs verbatim unless they already match the current Zelavis architecture.

## Audit Table

| Area | Decision | Proposed Zelavis Home | What To Preserve | What To Avoid |
| --- | --- | --- | --- | --- |
| Package split notes | Adapt | Root docs and future package READMEs | The instinct to separate core, SDK, UI, and adapters | A single umbrella package that owns storage, API, UI, and runtime |
| Server route manifests | Take | `@zelavis/server` | Packages expose route manifests; integrations mount them | Per-package hardcoded route registration that bypasses `ZelavisServerService` |
| JSON API reference | Adapt | Service-specific docs, likely `@zelavis/server` plus package READMEs | A stable HTTP shape for SDKs and external integrations | A universal `/zelavis/api/json/*` database API in core |
| Schema expression strings | Defer | Possible future `@zelavis/schema` | Portable schema descriptions for configs, dashboards, replication, or SDK generation | Committing to Effect Schema or string parsing in current core packages |
| Collection CRUD API | Reject for core | None for now | General lessons about validation, metadata, IDs, and timestamps | Adding a generic database/collection layer to Zelavis before domain packages need it |
| Repository abstraction | Take | `@zelavis/ecommerce`, `@zelavis/auth`, future packages | Storage stays behind explicit repository contracts | Exposing storage-driver details through domain APIs |
| In-memory storage | Take | Package-level `storage/in-memory.ts` | Local dev/test repositories improve adoption | Treating in-memory behavior as production semantics |
| Transactions | Adapt | Future repository/unit-of-work contracts | Callback-based atomic workflows for business invariants | Claiming database-level ACID without adapter guarantees |
| E-commerce transaction examples | Take as design input | `@zelavis/ecommerce` services | Checkout, inventory, order, and payment workflows need explicit consistency boundaries | Implementing generic transaction DSLs before repositories support them |
| File metadata plus blob storage | Adapt | Future `@zelavis/files` or `@zelavis/storage-files` | Separate metadata from binary storage; support checksums, MIME limits, file references | Coupling file storage to ecommerce/auth core |
| File HTTP routes | Adapt | Future file service mounted through `@zelavis/server` | Upload, download, metadata, delete, list route concepts | Hardcoding global file paths or multipart parsing inside core server contracts |
| File schema helpers | Defer | Future `@zelavis/files` plus optional schema package | Typed file-reference metadata can be useful | Adding `image()`, `mp3()`, etc. to unrelated package APIs |
| Offline file sync | Defer | Future browser/client package | Sync state model: pending, synced, failed | Making browser offline sync a baseline requirement for server-side libraries |
| Web/IndexedDB adapter | Defer | Future browser/client integration | Browser storage can be an adapter | Browser globals or no-op browser fallbacks in server-oriented code |
| Node/Bun/Deno adapters | Adapt | Runtime integrations as separate packages | Runtime adapters should be thin and explicit | Adapter names/functions using snake_case or bundling storage defaults with HTTP mounting |
| Cloudflare/Workers notes | Adapt later | Possible Cloudflare integration package | Edge runtime support is valuable | Distro packages that duplicate integration responsibilities |
| UI/dashboard notes | Adapt | `@zelavis/dashboard` | Dashboard should be optional and mountable | Bundling dashboard output into every runtime or making UI a core dependency |
| Examples | Adapt | Future `examples/*` in active repo | Keep small examples that prove package composition | Keeping generated starter-template README text as project guidance |
| Replication/load balancing notes | Defer | Future research docs or storage package | Honest consistency language: strong vs eventual, routing vs replication | Presenting replication as current Zelavis capability |
| SDKs as cluster members | Defer/rethink | Future client/sync research | Security requirement: clients only receive authorized data | Making every SDK a full cluster peer without a mature permissions model |
| User-selectable consistency | Defer | Future storage/sync APIs | Per-operation or per-namespace consistency choices are clearer than global toggles | Marketing eventual consistency as ACID |
| Governance docs | Adapt | Root `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` | Contribution and conduct templates can be useful | Copying archived docs without reviewing project-specific details |

## Near-Term Migration Queue

1. **Server contract hardening**
   - Keep improving `@zelavis/server` as the common mount contract.
   - Add tests around route prefixing, path overrides, error handling, and body/header normalization before adding more integrations.

2. **Domain repository consistency**
   - Keep ecommerce and auth storage behind interfaces.
   - Add optional unit-of-work style contracts only when an actual multi-step domain workflow needs them.

3. **File storage package design**
   - Draft a small `@zelavis/files` proposal before implementation.
   - Start with contracts: `FileMetadata`, `BlobStore`, `FileMetadataRepository`, `FileService`.
   - Add in-memory implementation first, then provider plugins or adapters.

4. **Dashboard boundaries**
   - Keep `@zelavis/dashboard` optional and server-rendered.
   - Let packages contribute dashboard sections through explicit contracts later.

5. **Docs cleanup**
   - Promote only implemented behavior from the archive into active READMEs.
   - Keep speculative material in the archive until there is code and tests.

## Deletion Readiness Checklist

Before removing the old prototype folder, confirm:

- All markdown and MDX notes are preserved under `docs/archive/early-zelavis-notes`.
- The archive has no old project/package naming.
- This audit exists and marks each major idea as take, adapt, reject, or defer.
- Any code worth porting has an explicit issue, task, or implementation plan in Zelavis.
- No active scripts, examples, or package metadata in Zelavis reference the old folder.

## Recommended First Implementations

1. Add root `typecheck` and `build` scripts so the workspace is easier to validate.
2. Add tests for `@zelavis/server` route resolution and integration behavior.
3. Write a short `@zelavis/files` design note from the archived file-storage material.
4. Decide whether transaction semantics belong in domain repositories, shared storage contracts, or individual adapters.
5. Add root contribution and conduct docs after reviewing the archived templates.
