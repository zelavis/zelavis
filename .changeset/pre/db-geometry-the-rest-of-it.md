---
"zelavis": minor
---

Complete spatial geometry capabilities in `zelavis/db`:
- Line geometries (`GeoLineString` and `GeoMultiLineString`) indexed with H3 cell sampling along segments at resolution + parent ancestors.
- Edge-to-edge intersection for polygons and lines without requiring interior vertices.
- Nearest-neighbour candidate ordering and distance cursor pagination in `findMany` and `findPage`, with `distance` in metres exposed on matching documents.
- Documented and enforced denial-of-service budgets for geometry vertices (`MAX_GEOMETRY_VERTICES = 10_000`) and rings (`MAX_GEOMETRY_RINGS = 500`).
