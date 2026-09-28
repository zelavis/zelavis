---
"zelavis": minor
---

Index and query geometry.

A collection can declare a `SpatialIndex`: which fields hold GeoJSON, an H3
resolution, and a version. Writes cover each geometry in cells and post them on
the term lens along with their ancestors, so a coarse query still meets a finely
indexed document. `findMany` and `findPage` take a `geometry` filter — `near` a
point within a radius in metres, `within` a bounding box, or `intersects` a
shape — and `locate` changes the index, rewriting documents under it.

Cells only produce candidates. The exact check runs on the real coordinates, so
what comes back is what the geometry admits: a document sharing a cell with the
centre but lying outside the radius does not appear.

Stated limits: distance is haversine on a sphere, about 0.3% from WGS84;
`intersects` holds when either shape contains a vertex of the other, so two
shapes crossing edge to edge with no vertex inside either are missed; coverings
are capped and coarsened to fit, with an over-large geometry carrying a sentinel
so it stays findable. Boxes crossing the antimeridian are split at the line.
Nearest-neighbour ordering is not included.

`h3-js` is an optional peer, needed only by collections that index geometry.
