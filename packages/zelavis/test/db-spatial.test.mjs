// Geometry: the exact checks, and the cells that only narrow the candidates.
//
// Cells are approximate by design — a cell covering a shape covers ground
// outside it — so everything a caller sees is decided by the exact check. These
// pin that check on the cases the shape of the Earth makes awkward: the
// antimeridian, the poles, holes, and rings given the wrong way round.
import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import {
  contains, distanceBetween, distanceToGeometry, distanceToSegment, inBox, loadH3, cellsFor, coveringFor,
  intersectsGeometry, segmentsIntersect, boundingBoxOf, boundingBoxesOverlap,
  assertGeometryBudget, MAX_GEOMETRY_VERTICES, MAX_GEOMETRY_RINGS, COARSEST_RESOLUTION,
} from "../dist/db/spatial.js";

const BERLIN = [13.405, 52.52];
const PARIS = [2.3522, 48.8566];

test("distance is metres on a sphere, and says so", () => {
  // Berlin to Paris is about 878 km; haversine on a sphere lands within a few
  // kilometres of the ellipsoid's answer, which is the documented trade.
  const metres = distanceBetween(BERLIN, PARIS);
  assert.ok(Math.abs(metres - 878_000) < 10_000, `${Math.round(metres)} m`);
  assert.equal(distanceBetween(BERLIN, BERLIN), 0);

  // Across the antimeridian: 1 degree apart, not 359.
  const west = distanceBetween([179.5, 0], [-179.5, 0]);
  assert.ok(Math.abs(west - 111_195) < 2_000, `${Math.round(west)} m across the line`);
});

test("a polygon contains what it encloses, and not its holes", () => {
  const square = {
    type: "Polygon",
    coordinates: [
      [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]],
      // A hole in the middle: inside the outer ring, outside the polygon.
      [[1, 1], [3, 1], [3, 3], [1, 3], [1, 1]],
    ],
  };
  assert.equal(contains(square, [0.5, 0.5]), true, "between the rings");
  assert.equal(contains(square, [2, 2]), false, "in the hole");
  assert.equal(contains(square, [5, 5]), false, "outside entirely");

  // Wound the other way: orientation is not containment, so it must not change the answer.
  const reversed = { type: "Polygon", coordinates: [[...square.coordinates[0]].reverse()] };
  assert.equal(contains(reversed, [2, 2]), true);

  const multi = { type: "MultiPolygon", coordinates: [square.coordinates, [[[10, 10], [12, 10], [12, 12], [10, 12], [10, 10]]]] };
  assert.equal(contains(multi, [11, 11]), true, "any part counts");
  assert.equal(contains(multi, [2, 2]), false, "and a hole is still a hole");
});

test("a polygon spanning the antimeridian is one polygon", () => {
  // 178E to 178W across the line, not the long way round the globe.
  const straddle = {
    type: "Polygon",
    coordinates: [[[178, -1], [-178, -1], [-178, 1], [178, 1], [178, -1]]],
  };
  assert.equal(contains(straddle, [179.5, 0]), true, "east of the line");
  assert.equal(contains(straddle, [-179.5, 0]), true, "west of it");
  assert.equal(contains(straddle, [0, 0]), false, "and not the other side of the world");
});

test("a bounding box crossing the antimeridian keeps both sides", () => {
  const box = { west: 170, south: -10, east: -170, north: 10 };
  assert.equal(inBox(box, [175, 0]), true);
  assert.equal(inBox(box, [-175, 0]), true);
  assert.equal(inBox(box, [0, 0]), false);
  assert.equal(inBox(box, [175, 20]), false, "latitude still bounds it");

  const ordinary = { west: 0, south: 0, east: 10, north: 10 };
  assert.equal(inBox(ordinary, [5, 5]), true);
  assert.equal(inBox(ordinary, [15, 5]), false);
});

test("a covering names the cell and its ancestors", async () => {
  const h3 = await Effect.runPromise(loadH3);
  const point = { type: "Point", coordinates: BERLIN };
  const cells = cellsFor(h3, point, 7);

  assert.ok(cells.every((cell) => h3.isValidCell(cell)), "every cell is a cell");
  assert.equal(cells.length, 7 - COARSEST_RESOLUTION + 1, "one per level, finest to coarsest");
  assert.ok(cells.includes(h3.latLngToCell(52.52, 13.405, 7)), "the point's own cell");
  assert.ok(cells.includes(h3.cellToParent(h3.latLngToCell(52.52, 13.405, 7), COARSEST_RESOLUTION)));

  // A polygon covers more than one cell, and a point inside it shares one.
  const area = {
    type: "Polygon",
    coordinates: [[[13.3, 52.4], [13.5, 52.4], [13.5, 52.6], [13.3, 52.6], [13.3, 52.4]]],
  };
  const covering = cellsFor(h3, area, 7);
  assert.ok(covering.length > 1, `a square of Berlin took ${covering.length} cells`);
  assert.ok(covering.some((cell) => cells.includes(cell)), "the point's cells meet the area's");

  // A polygon smaller than one cell still lands somewhere: its vertices are indexed.
  const tiny = {
    type: "Polygon",
    coordinates: [[[13.405, 52.52], [13.4051, 52.52], [13.4051, 52.5201], [13.405, 52.5201], [13.405, 52.52]]],
  };
  assert.ok(cellsFor(h3, tiny, 7).length > 0, "a shape narrower than a cell is still indexed");
});

test("a line string indexes cells continuously along its path and contains its points", async () => {
  const h3 = await Effect.runPromise(loadH3);
  const line = {
    type: "LineString",
    coordinates: [[13.3777, 52.5163], [13.4094, 52.5208]],
  };
  const cells = cellsFor(h3, line, 8);
  assert.ok(cells.length > 2, `line produced ${cells.length} cells`);
  assert.ok(cells.includes(h3.latLngToCell(52.5163, 13.3777, 8)));
  assert.ok(cells.includes(h3.latLngToCell(52.5208, 13.4094, 8)));

  const covering = coveringFor(h3, line, 8);
  assert.ok(covering.cells.length > 0);
  assert.equal(covering.resolution, 8);

  // Containment on line
  assert.equal(contains(line, [13.3777, 52.5163]), true, "endpoint is on line");
  assert.equal(contains(line, [13.4094, 52.5208]), true, "endpoint is on line");
  // Point halfway along the segment
  const mid = [
    (13.3777 + 13.4094) / 2,
    (52.5163 + 52.5208) / 2,
  ];
  assert.equal(contains(line, mid), true, "midpoint is on line");
  assert.equal(contains(line, [13.3777, 52.6]), false, "point far north is not on line");
});

test("two polygons crossing edge-to-edge intersect even with no vertex inside either", () => {
  // A vertical rectangle and a horizontal rectangle crossing in a plus sign (+)
  const vertical = {
    type: "Polygon",
    coordinates: [[[2, 0], [3, 0], [3, 10], [2, 10], [2, 0]]],
  };
  const horizontal = {
    type: "Polygon",
    coordinates: [[[0, 4], [10, 4], [10, 5], [0, 5], [0, 4]]],
  };

  // Verify that neither polygon's vertices lie inside the other
  const vInH = vertical.coordinates[0].some((p) => contains(horizontal, p));
  const hInV = horizontal.coordinates[0].some((p) => contains(vertical, p));
  assert.equal(vInH, false, "no vertex of vertical is inside horizontal");
  assert.equal(hInV, false, "no vertex of horizontal is inside vertical");

  // But they intersect!
  assert.equal(intersectsGeometry(vertical, horizontal), true, "vertical intersects horizontal");
  assert.equal(intersectsGeometry(horizontal, vertical), true, "symmetric intersection");

  // Non-intersecting polygons
  const disjoint = {
    type: "Polygon",
    coordinates: [[[20, 20], [25, 20], [25, 25], [20, 25], [20, 20]]],
  };
  assert.equal(intersectsGeometry(vertical, disjoint), false, "disjoint polygons do not intersect");
});

test("distanceToGeometry calculates accurate distances to points, lines, and polygons", () => {
  const line = {
    type: "LineString",
    coordinates: [[13.37, 52.51], [13.39, 52.51]],
  };
  // A point directly north of the midpoint of line (0.01 deg lat away)
  const query = [13.38, 52.52];
  const dist = distanceToGeometry(query, line);
  // ~1112 metres (perpendicular distance to midpoint)
  assert.ok(Math.abs(dist - 1112) < 2, `expected ~1112m, got ${dist}m`);

  // Distance to a polygon:
  const poly = {
    type: "Polygon",
    coordinates: [[[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]]],
  };
  assert.equal(distanceToGeometry([2, 2], poly), 0, "point inside polygon has distance 0");
  const outsideDist = distanceToGeometry([6, 2], poly);
  assert.ok(outsideDist > 200_000, `distance to polygon edge is positive: ${outsideDist}m`);
});

test("denial-of-service budget prevents processing pathologically large geometries", () => {
  // Geometry exceeding MAX_GEOMETRY_VERTICES
  const hugeCoords = [];
  for (let i = 0; i <= MAX_GEOMETRY_VERTICES + 10; i++) {
    hugeCoords.push([13.4 + i * 0.0001, 52.5]);
  }
  const hugeLine = {
    type: "LineString",
    coordinates: hugeCoords,
  };
  assert.throws(
    () => assertGeometryBudget(hugeLine),
    /Geometry exceeds maximum vertex budget/,
  );

  // Geometry exceeding MAX_GEOMETRY_RINGS
  const manyRings = [];
  for (let i = 0; i <= MAX_GEOMETRY_RINGS + 5; i++) {
    manyRings.push([[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]);
  }
  const hugePoly = {
    type: "Polygon",
    coordinates: manyRings,
  };
  assert.throws(
    () => assertGeometryBudget(hugePoly),
    /Geometry exceeds maximum ring budget/,
  );
});
