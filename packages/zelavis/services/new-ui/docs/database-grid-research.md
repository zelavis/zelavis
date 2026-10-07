# Database grid candidates

Research date: 2026-10-07. This is a documentation and source review, not a performance benchmark or implementation decision.

## Recommendation

Keep Glide Data Grid as the first-port baseline in a Fuzor React island. React is a supported island adapter in Fuzor, so a React dependency is not itself a reason to replace the grid. Evaluate VTable as the strongest canvas alternative if broader analytics are a goal; evaluate Tabulator if built-in database administration features matter more than retaining canvas rendering. Do not adopt another grid based on its advertised maximum row count.

## Current Zelavis behavior

The original UI uses Glide's DataEditor in `zelavis-ui/app/routes/database.tsx`. Zelavis implements filtering, sorting, column visibility/order, pinning and saved views around the grid. Cells currently return read-only values; row creation lives in a separate drawer. The current filter/sort functions operate on the fetched rows. Replacing the renderer alone would not make those operations cover an entire server-side dataset.

Keep data access, real Project/Tenant scope, query state and mutation authorization outside a vendor-specific grid. System Store and logical System Table inspection remain read-only. Grid editor/clipboard/undo features do not by themselves authorize or persist database changes.

## Candidates

| Library | Integration/rendering | Relevant strengths | Limits to consider |
| --- | --- | --- | --- |
| Glide Data Grid | React island, canvas | MIT; typed/custom cells, editing, selection, frozen columns; reuse existing Zelavis behavior | Sorting/filtering are application/data-source responsibilities; custom drawing uses canvas |
| VisActor VTable | Plain JavaScript island, canvas | MIT core; list/pivot tables, analysis/chart integration; editor packages and asynchronous cached data-source support | New adapter and themes; need actual keyboard/screen-reader, mobile, bundle and remote-query tests |
| Tabulator | Plain JavaScript island, virtual DOM | MIT; editing, validation, remote pagination, filtering, grouping, tree data, range selection, clipboard, export and history | Different rendering/interaction model; benchmark wide datasets and scrolling against Glide |
| RevoGrid | Native web component, virtual DOM | MIT core; editing, range selection, copy/paste, filters, pinning and grouping | Documented Pro features include server loading/infinite scroll, remote pagination, server-side grouping, edit history and richer structured clipboard workflows |
| AG Grid | Plain JavaScript or React island, virtual DOM | Community: MIT, sorting/filtering/editing, pagination, infinite row model and accessibility APIs | Enterprise requires commercial licensing for advanced features including the Server-Side Row Model, pivoting, range selection and enhanced clipboard; infinite loading is available in Community |

## Small evaluation before switching

Use the same Project/Tenant API adapter and dataset in each candidate. Include a wide table, JSON/null/missing fields, stable row IDs, remote paging/sort/filter, selected-record URL restoration, mobile sidebar resizing, keyboard and screen-reader operation, and unmount during a pending request. Measure production bundle cost, scroll responsiveness and memory. Confirm editable cells can await validation/persistence, reject failed writes, and avoid silently treating local undo as a database rollback.

## Primary sources

- Glide capabilities, license and data-source responsibilities: https://github.com/glideapps/glide-data-grid
- VTable core, package boundaries and license: https://github.com/VisActor/VTable
- VTable editors: https://visactor.io/vtable/guide/edit/edit_cell
- VTable asynchronous data source: https://visactor.io/vtable/guide/data/async_data
- VTable keyboard options: https://visactor.io/vtable/guide/shortcut
- Tabulator features: https://www.tabulator.info/
- Tabulator license: https://github.com/tabulator-tables/tabulator
- RevoGrid core/Pro feature boundary and license: https://github.com/revolist/revogrid
- AG Grid Community/Enterprise boundary: https://www.ag-grid.com/javascript-data-grid/community-vs-enterprise/
- AG Grid row models: https://www.ag-grid.com/javascript-data-grid/row-models/
