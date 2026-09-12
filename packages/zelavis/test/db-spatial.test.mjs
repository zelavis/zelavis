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
  contains, distanceBetween, inBox, loadH3, cellsFor, COARSEST_RESOLUTION,
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
