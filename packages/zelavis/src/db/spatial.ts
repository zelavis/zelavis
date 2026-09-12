/**
 * Geometry, as coordinates the database can index and check exactly.
 *
 * Two halves that must not be confused. Cells — H3's hierarchical hexagons —
 * narrow a query to candidates, cheaply and approximately: a cell covering a
 * shape covers ground outside it too. The exact check then decides, on the
 * real coordinates. Every query here returns what the exact check admits, so a
 * coarser resolution costs work rather than correctness.
 *
 * Coordinates are WGS84 longitude and latitude, in that order, as GeoJSON
 * writes them. H3 takes latitude first, which is the one place the two
 * conventions meet and the only place this file swaps them.
 */
import { Effect } from "effect";
import { StoreError } from "./errors.js";

/** A position: longitude then latitude, degrees, WGS84. */
export type Position = readonly [longitude: number, latitude: number];

/** A ring's first and last position are the same; holes follow the outer ring. */
export type Ring = ReadonlyArray<Position>;

export interface GeoPoint {
  readonly type: "Point";
  readonly coordinates: Position;
}

export interface GeoPolygon {
  readonly type: "Polygon";
  /** The outer ring first; every ring after it is a hole. */
  readonly coordinates: ReadonlyArray<Ring>;
}

export interface GeoMultiPolygon {
  readonly type: "MultiPolygon";
  readonly coordinates: ReadonlyArray<ReadonlyArray<Ring>>;
}

export type Geometry = GeoPoint | GeoPolygon | GeoMultiPolygon;

/** West, south, east, north — degrees, WGS84. A box crossing the antimeridian has west > east. */
export interface BoundingBox {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
}

/** The mean radius of the Earth, in metres: what a distance in metres means here. */
const EARTH_RADIUS = 6_371_008.8;

const radians = (degrees: number) => (degrees * Math.PI) / 180;

/**
 * Great-circle distance in metres.
 *
 * Haversine on a sphere, not an ellipsoid: about 0.3% from WGS84's true
 * distance at worst. That is stated rather than hidden, because a radius query
 * is a promise about metres.
 */
export const distanceBetween = (a: Position, b: Position): number => {
  const [lonA, latA] = a;
  const [lonB, latB] = b;
  const dLat = radians(latB - latA);
  const dLon = radians(lonB - lonA);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(latA)) * Math.cos(radians(latB)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(h)));
};

/**
 * Whether a position lies inside a ring, by the even-odd rule.
 *
 * A ray cast east from the point crosses the ring an odd number of times when
 * it is inside. Longitudes are unwrapped relative to the point first, so a ring
 * spanning the antimeridian is one ring rather than two halves of the world.
 */
const insideRing = (point: Position, ring: Ring): boolean => {
  const anchor = ring[0]?.[0];
  if (anchor === undefined) return false;
  // Every longitude — the ring's and the point's — is brought within half a
  // turn of one reference vertex. Unwrapping each vertex against the point
  // instead would tear a ring that crosses the antimeridian in two, and a
  // point on the far side of the world could then fall "inside" it.
  const near = (value: number) => {
    const delta = value - anchor;
    return delta > 180 ? value - 360 : delta < -180 ? value + 360 : value;
  };
  const lon = near(point[0]);
  const lat = point[1];
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xiRaw, yi] = ring[i]!;
    const [xjRaw, yj] = ring[j]!;
    const xi = near(xiRaw);
    const xj = near(xjRaw);
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
};

/** Inside the outer ring and outside every hole. */
const insidePolygon = (point: Position, rings: ReadonlyArray<Ring>): boolean => {
  const [outer, ...holes] = rings;
  if (outer === undefined || !insideRing(point, outer)) return false;
  return !holes.some((hole) => insideRing(point, hole));
};

/** Whether a geometry contains a position, exactly. A point contains only itself. */
export const contains = (geometry: Geometry, point: Position): boolean => {
  switch (geometry.type) {
    case "Point":
      return geometry.coordinates[0] === point[0] && geometry.coordinates[1] === point[1];
    case "Polygon":
      return insidePolygon(point, geometry.coordinates);
    case "MultiPolygon":
      return geometry.coordinates.some((rings) => insidePolygon(point, rings));
  }
};

/** Every position a geometry is made of, for the checks that work position-wise. */
export const positionsOf = (geometry: Geometry): ReadonlyArray<Position> => {
  switch (geometry.type) {
    case "Point":
      return [geometry.coordinates];
    case "Polygon":
      return geometry.coordinates.flat();
    case "MultiPolygon":
      return geometry.coordinates.flat(2);
  }
};

/** Whether a position falls in a box, honouring one that crosses the antimeridian. */
export const inBox = (box: BoundingBox, point: Position): boolean => {
  const [lon, lat] = point;
  if (lat < box.south || lat > box.north) return false;
  return box.west <= box.east
    ? lon >= box.west && lon <= box.east
    : lon >= box.west || lon <= box.east;
};

/**
 * The subset of `h3-js` this uses.
 *
 * Declared rather than imported as a type, so the package stays an optional
 * peer: a collection that indexes no geometry should not have to have it.
 */
interface H3 {
  latLngToCell: (lat: number, lng: number, resolution: number) => string;
  cellToChildrenSize?: (cell: string, resolution: number) => number;
  cellToParent: (cell: string, resolution: number) => string;
  gridDisk: (cell: string, radius: number) => ReadonlyArray<string>;
  /** The average edge length of a cell at a resolution, which sizes a disk honestly. */
  getHexagonEdgeLengthAvg: (resolution: number, unit: "m" | "km") => number;
  polygonToCells: (
    polygon: ReadonlyArray<ReadonlyArray<ReadonlyArray<number>>>,
    resolution: number,
    isGeoJson?: boolean,
  ) => ReadonlyArray<string>;
  isValidCell: (cell: string) => boolean;
}

export const loadH3 = Effect.tryPromise({
  try: async () => {
    const mod = (await import("h3-js")) as unknown as H3 & { default?: H3 };
    return (mod.default ?? mod) as H3;
  },
  catch: (cause) =>
    new StoreError({
      op: "spatial.load",
      cause: new Error(
        "Indexing geometry needs the optional `h3-js` package installed. " +
          `Install it alongside zelavis to use spatial fields. Cause: ${String(cause)}`,
      ),
    }),
});

/**
 * The cells a geometry is indexed under: the covering cell at the declared
 * resolution, and its ancestors.
 *
 * Ancestors are what make a coarse query cheap — a wide radius asks for a few
 * coarse cells rather than thousands of fine ones — and they cost one posting
 * per level on a write, which is the same trade the time-series buckets made
 * before ranges replaced them. Here it stays, because a cell is not an
 * interval: there is no ordered lens over the globe to range across.
 */
export const COARSEST_RESOLUTION = 2;

/**
 * The cells a radius could touch: a disk sized from H3's own cell measurements.
 *
 * The resolution is coarsened until the disk is a handful of rings rather than
 * thousands, and the ring count comes from the reported edge length — a cell's
 * centre-to-centre step is about one and a half edges — with a ring of slack,
 * because the centre sits anywhere within its own cell. Guessing a cell's size
 * instead of asking is how a covering silently misses documents: at resolution
 * 9 an invented span of 1.6 km stood against a true edge of 0.2 km.
 */
export const diskFor = (
  h3: Pick<H3, "latLngToCell" | "gridDisk" | "getHexagonEdgeLengthAvg">,
  centre: Position,
  radius: number,
  finest: number,
): ReadonlyArray<string> => {
  let resolution = finest;
  let rings = Number.POSITIVE_INFINITY;
  while (resolution > COARSEST_RESOLUTION) {
    const step = h3.getHexagonEdgeLengthAvg(resolution, "m") * 1.5;
    rings = Math.ceil(radius / step) + 1;
    if (rings <= 8) break;
    resolution -= 1;
  }
  if (!Number.isFinite(rings)) {
    rings = Math.ceil(radius / (h3.getHexagonEdgeLengthAvg(resolution, "m") * 1.5)) + 1;
  }
  return h3.gridDisk(h3.latLngToCell(centre[1], centre[0], resolution), Math.max(1, rings));
};

/**
 * A box as geometry, split where it crosses the antimeridian.
 *
 * A box whose west is east of its east wraps the date line, and a single ring
 * written `west, east, east, west` is read the long way round instead: the
 * Pacific becomes most of the planet. Two boxes meeting at the line are the
 * same area and stay small — the covering of the wrapped ring grows sevenfold
 * a level, which is a query that never returns rather than one that is slow.
 */
export const boxGeometry = (box: BoundingBox): ReadonlyArray<GeoPolygon> => {
  const ring = (west: number, east: number): GeoPolygon => ({
    type: "Polygon",
    coordinates: [[
      [west, box.south], [east, box.south], [east, box.north], [west, box.north], [west, box.south],
    ]],
  });
  return box.west <= box.east
    ? [ring(box.west, box.east)]
    : [ring(box.west, 180), ring(-180, box.east)];
};

/**
 * Cells a covering may name before it is coarsened.
 *
 * Past this the candidates cost more to union than the exact check saves, and
 * a covering that grows without bound is a denial of service wearing the shape
 * of a query.
 */
export const MAX_COVERING = 4096;

/**
 * The finest covering of a geometry that stays within the cap, with the
 * resolution it reached.
 *
 * Refined from the coarsest upward rather than the other way about: a covering
 * at a fine resolution can be enormous, and asking for it to find out how
 * enormous is the mistake this exists to avoid. Each level costs roughly seven
 * times the last, so this stops before the step that would exceed the cap.
 */
export const coveringFor = (
  h3: H3,
  geometry: Geometry,
  finest: number,
): { readonly cells: ReadonlyArray<string>; readonly resolution: number } => {
  const polygons: ReadonlyArray<ReadonlyArray<Ring>> = geometry.type === "Point"
    ? []
    : geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  if (geometry.type === "Point") {
    const [lon, lat] = geometry.coordinates;
    return { cells: [h3.latLngToCell(lat, lon, finest)], resolution: finest };
  }
  let best: ReadonlyArray<string> = [];
  let reached = COARSEST_RESOLUTION;
  for (let resolution = COARSEST_RESOLUTION; resolution <= finest; resolution++) {
    const cells = new Set<string>();
    for (const polygon of polygons) {
      for (const cell of h3.polygonToCells(polygon.map((ring) => ring.map((p) => [...p])), resolution, true)) {
        cells.add(cell);
      }
      // Vertices too, so a shape narrower than a cell still lands somewhere.
      for (const position of polygon.flat()) cells.add(h3.latLngToCell(position[1], position[0], resolution));
    }
    if (cells.size > MAX_COVERING) break;
    best = [...cells];
    reached = resolution;
  }
  return { cells: best, resolution: reached };
};

export const cellsFor = (h3: H3, geometry: Geometry, resolution: number): ReadonlyArray<string> => {
  const cells = new Set<string>();
  const add = (cell: string) => {
    cells.add(cell);
    for (let level = resolution - 1; level >= COARSEST_RESOLUTION; level--) {
      cells.add(h3.cellToParent(cell, level));
    }
  };
  if (geometry.type === "Point") {
    const [lon, lat] = geometry.coordinates;
    add(h3.latLngToCell(lat, lon, resolution));
    return [...cells];
  }
  const rings = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  for (const polygon of rings) {
    // GeoJSON order, which h3 takes when told so; every vertex is indexed too,
    // so a polygon narrower than a cell still lands somewhere.
    for (const cell of h3.polygonToCells(polygon.map((ring) => ring.map((p) => [...p])), resolution, true)) {
      add(cell);
    }
    for (const position of polygon.flat()) add(h3.latLngToCell(position[1], position[0], resolution));
  }
  return [...cells];
};
