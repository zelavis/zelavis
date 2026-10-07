# Database grid experiment

The Project Database and Content workspaces can render the same records in three MIT-licensed libraries. Use the buttons above the grid or the `grid=glide`, `grid=tabulator`, and `grid=vtable` URL parameters. Glide is the default.

| Library | Exact version | Integration | What this prototype exposes |
| --- | --- | --- | --- |
| Glide Data Grid | 6.0.3 | Fuzor React island | Canvas cells, spreadsheet selection/copy, resizable columns, JSON cell editors |
| Tabulator | 6.6.1 | Fuzor DOM island | DOM rows/cells, column dragging/resizing, row selection, JSON cell editors |
| VisActor VTable | 1.26.8 | Fuzor canvas island | Canvas selection/copy, column resizing, JSON cell editors |

All three share explicit Project and Tenant scope, bounded server paging (up to 250 records per page), URL-backed page filtering/sorting, a selected-record JSON inspector, staged changes and version-checked saves through the existing Database API. Switching libraries retains staged changes. Reloading, changing pages/Tenants/tables, and leaving the workspace discard local drafts; save before those actions. Multiple record saves are sequential, not an atomic batch. Successful rows are removed from the draft set; a failure retains the remaining drafts. Refresh is required to resolve a version conflict, so copy drafts from the inspector first if needed.

Filtering and sorting operate only on the loaded page. The test exercises the document projection with numeric, boolean, null, nested-object, array, missing and literal dotted fields. It does **not** yet compare graph visualization, time-series charts, a complete column lens, or server-wide analytic queries. VTable pivot/chart and Tabulator grouping/tree modes remain separate follow-up experiments. A plain list is the common baseline, not evidence that one engine wins those specialized workloads.

Grid-specific source is lazy-loaded. The shared workspace is a Fuzor island; only Glide imports React. All adapters release their grids, observers and editor portals when switching engines or leaving the route. VTable uses one editor instance per grid, cancels it on disposal, and opens edits by double-click or Enter; eager keydown preparation is disabled because the pinned release queues an uncancellable delayed callback that can run after disposal. The page owns island cleanup through Fuzor's public lifecycle API.

## Install and validate

From this package directory:

```sh
npm ci --prefix grid-dependencies --ignore-scripts --legacy-peer-deps --no-audit --no-fund
node scripts/link-local.mjs
node scripts/typecheck.mjs
node scripts/build.mjs
node --test tests/*.test.mjs
node scripts/dev.mjs --frontend=fuzor
```

Dependencies and their npm lockfile live in `grid-dependencies`, isolated from the parent pnpm workspace. React 18 satisfies Glide's published peer range. The first local install needs registry access. Fuzor must already be built in its sibling checkout, as described in the package README.

## License verification

The exact installed grid manifests must declare MIT and match their pinned versions; build and unit tests enforce this. The build retains their copyright/permission notices in `dist-spa/assets/grid-licenses.txt`. VTable's npm package declares MIT but omits its license file, so the notice from its published source commit `a938bf7988391b6c2420f9fd2e0ada40a52b9f8e` is retained locally in `grid-dependencies/VTable-LICENSE.txt`.

Sources: [Glide license](https://github.com/glideapps/glide-data-grid/blob/main/LICENSE), [Tabulator license](https://github.com/tabulator-tables/tabulator/blob/master/LICENSE), [VTable license](https://github.com/VisActor/VTable/blob/a938bf7988391b6c2420f9fd2e0ada40a52b9f8e/LICENSE). The library requirement is MIT; their open-source dependency graph has its own notices and licenses. No paid grid edition is used.

## Verification on 2026-10-07

Typechecking, the SPA build and 20 unit tests pass. Manual browser checks used a disposable native Project with 40 synthetic records: all three grids rendered, their cell editors staged typed JSON, switches preserved drafts, saves advanced the record version, a concurrent update rejected the stale save while retaining its draft, 25/100-row paging and Back restoration worked, numeric sorting and explicit page filtering worked, and logical System Tables exposed no save action. Desktop/mobile layouts and the embedded static build were checked; these are functional checks, not throughput benchmarks.
