---
"zelavis": minor
---

Time-Series Slice Two: series and distribution operations, gap filling, and HTTP tag filter support.

Added operations that answer with a series or distribution rather than a single aggregate number:
- `timeSeries.windows`: tumbling buckets and sliding windows (`step < interval`) with configurable aggregation operations and gap filling (`fill`: `"none" | "zero" | "previous" | "linear"`).
- `timeSeries.moving`: rolling window aggregations across time durations or point counts.
- `timeSeries.histogram`: value frequency distributions with configurable bin counts, explicit boundaries, or fixed step widths, alongside statistical summaries (`min`, `max`, `count`, `sum`, `avg`).
- `timeSeries.interpolate`: regular time-grid resampling with `"linear"`, `"previous"`, or `"next"` interpolation methods.
- HTTP Routes: mounted `POST /timeseries/:series/windows`, `/moving`, `/histogram`, `/interpolate`, and `/ingest`.
- HTTP Tag Filtering: wired tag filter support into `POST /timeseries/:series/range` and `/aggregate` so tags are honoured over the wire as well as in process.
