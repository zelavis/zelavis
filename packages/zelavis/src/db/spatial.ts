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

export interface GeoLineString {
  readonly type: "LineString";
  readonly coordinates: ReadonlyArray<Position>;
}

export interface GeoMultiLineString {
  readonly type: "MultiLineString";
  readonly coordinates: ReadonlyArray<ReadonlyArray<Position>>;
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

export type Geometry = GeoPoint | GeoLineString | GeoMultiLineString | GeoPolygon | GeoMultiPolygon;

/**
 * Maximum vertices allowed in a single geometry across all rings or segments.
 *
 * Prevents denial-of-service from point-in-polygon ray casting and segment
 * intersections on pathologically dense shapes.
 */
export const MAX_GEOMETRY_VERTICES = 10_000;

/**
 * Maximum rings allowed in a polygon or multipolygon.
 *
 * Prevents CPU exhaustion when checking containment or intersections across
 * thousands of nested holes or islands.
 */
export const MAX_GEOMETRY_RINGS = 500;

/**
 * Asserts that a geometry stays within the denial-of-service vertex and ring budgets.
 */
export const assertGeometryBudget = (geometry: Geometry): void => {
  let vertexCount = 0;
  let ringCount = 0;
  switch (geometry.type) {
    case "Point":
      vertexCount = 1;
      break;
    case "LineString":
      vertexCount = geometry.coordinates.length;
      break;
    case "MultiLineString":
      for (const line of geometry.coordinates) {
        vertexCount += line.length;
      }
      break;
    case "Polygon":
      ringCount = geometry.coordinates.length;
      for (const ring of geometry.coordinates) {
        vertexCount += ring.length;
      }
      break;
    case "MultiPolygon":
      for (const poly of geometry.coordinates) {
        ringCount += poly.length;
        for (const ring of poly) {
          vertexCount += ring.length;
        }
      }
      break;
  }
  if (vertexCount > MAX_GEOMETRY_VERTICES) {
    throw new RangeError(
      `Geometry exceeds maximum vertex budget (${vertexCount} > ${MAX_GEOMETRY_VERTICES})`,
    );
  }
  if (ringCount > MAX_GEOMETRY_RINGS) {
    throw new RangeError(
      `Geometry exceeds maximum ring budget (${ringCount} > ${MAX_GEOMETRY_RINGS})`,
    );
  }
};

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

/**
 * Great-circle distance in metres from a point to a line segment.
 */
export const distanceToSegment = (point: Position, a: Position, b: Position): number => {
  const anchor = point[0];
  const near = (v: number) => {
    const delta = v - anchor;
    return delta > 180 ? v - 360 : delta < -180 ? v + 360 : v;
  };
  const cosLat = Math.cos(radians(point[1]));
  const degToM = (Math.PI / 180) * EARTH_RADIUS;
  const ax = (near(a[0]) - anchor) * cosLat * degToM;
  const ay = (a[1] - point[1]) * degToM;
  const bx = (near(b[0]) - anchor) * cosLat * degToM;
  const by = (b[1] - point[1]) * degToM;

  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-6) return distanceBetween(point, a);

  const t = Math.max(0, Math.min(1, (-ax * dx - ay * dy) / lenSq));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.sqrt(cx * cx + cy * cy);
};

const pointOnLine = (point: Position, line: ReadonlyArray<Position>): boolean => {
  for (let i = 0; i < line.length - 1; i++) {
    if (distanceToSegment(point, line[i]!, line[i + 1]!) < 0.1) return true;
  }
  return false;
};

/** Whether a geometry contains a position, exactly. A point contains only itself. */
export const contains = (geometry: Geometry, point: Position): boolean => {
  switch (geometry.type) {
    case "Point":
      return geometry.coordinates[0] === point[0] && geometry.coordinates[1] === point[1];
    case "LineString":
      return pointOnLine(point, geometry.coordinates);
    case "MultiLineString":
      return geometry.coordinates.some((line) => pointOnLine(point, line));
    case "Polygon":
      return insidePolygon(point, geometry.coordinates);
    case "MultiPolygon":
      return geometry.coordinates.some((rings) => insidePolygon(point, rings));
  }
};

/**
 * Shortest great-circle distance in metres from a query point to a geometry.
 *
 * For a point: great-circle distance to that point.
 * For a line or multiline: minimum distance to any of its segments.
 * For a polygon or multipolygon: 0 if the point is enclosed, otherwise
 * the minimum distance to any edge of the outer boundary or holes.
 */
export const distanceToGeometry = (point: Position, geometry: Geometry): number => {
  assertGeometryBudget(geometry);
  switch (geometry.type) {
    case "Point":
      return distanceBetween(point, geometry.coordinates);
    case "LineString": {
      let min = Number.POSITIVE_INFINITY;
      for (let i = 0; i < geometry.coordinates.length - 1; i++) {
        const d = distanceToSegment(point, geometry.coordinates[i]!, geometry.coordinates[i + 1]!);
        if (d < min) min = d;
      }
      return Number.isFinite(min) ? min : (geometry.coordinates[0] ? distanceBetween(point, geometry.coordinates[0]) : 0);
    }
    case "MultiLineString": {
      let min = Number.POSITIVE_INFINITY;
      for (const line of geometry.coordinates) {
        for (let i = 0; i < line.length - 1; i++) {
          const d = distanceToSegment(point, line[i]!, line[i + 1]!);
          if (d < min) min = d;
        }
      }
      return Number.isFinite(min) ? min : 0;
    }
    case "Polygon": {
      if (contains(geometry, point)) return 0;
      let min = Number.POSITIVE_INFINITY;
      for (const ring of geometry.coordinates) {
        for (let i = 0; i < ring.length - 1; i++) {
          const d = distanceToSegment(point, ring[i]!, ring[i + 1]!);
          if (d < min) min = d;
        }
      }
      return Number.isFinite(min) ? min : 0;
    }
    case "MultiPolygon": {
      if (contains(geometry, point)) return 0;
      let min = Number.POSITIVE_INFINITY;
      for (const poly of geometry.coordinates) {
        for (const ring of poly) {
          for (let i = 0; i < ring.length - 1; i++) {
            const d = distanceToSegment(point, ring[i]!, ring[i + 1]!);
            if (d < min) min = d;
          }
        }
      }
      return Number.isFinite(min) ? min : 0;
    }
  }
};

/** Every position a geometry is made of, for the checks that work position-wise. */
export const positionsOf = (geometry: Geometry): ReadonlyArray<Position> => {
  switch (geometry.type) {
    case "Point":
      return [geometry.coordinates];
    case "LineString":
      return geometry.coordinates;
    case "MultiLineString":
      return geometry.coordinates.flat();
    case "Polygon":
      return geometry.coordinates.flat();
    case "MultiPolygon":
      return geometry.coordinates.flat(2);
  }
};

/**
 * 2D cross-product of vectors AB and AC.
 */
const ccw = (a: readonly [number, number], b: readonly [number, number], c: readonly [number, number]) =>
  (c[1] - a[1]) * (b[0] - a[0]) - (c[0] - a[0]) * (b[1] - a[1]);

const onSegment = (p: readonly [number, number], a: readonly [number, number], b: readonly [number, number]) =>
  p[0] >= Math.min(a[0], b[0]) - 1e-9 && p[0] <= Math.max(a[0], b[0]) + 1e-9 &&
  p[1] >= Math.min(a[1], b[1]) - 1e-9 && p[1] <= Math.max(a[1], b[1]) + 1e-9;

/**
 * Whether two line segments intersect, unwrapping longitudes across the antimeridian.
 */
export const segmentsIntersect = (
  a1: Position,
  a2: Position,
  b1: Position,
  b2: Position,
): boolean => {
  const anchor = a1[0];
  const near = (v: number) => {
    const delta = v - anchor;
    return delta > 180 ? v - 360 : delta < -180 ? v + 360 : v;
  };
  const pa1: readonly [number, number] = [a1[0], a1[1]];
  const pa2: readonly [number, number] = [near(a2[0]), a2[1]];
  const pb1: readonly [number, number] = [near(b1[0]), b1[1]];
  const pb2: readonly [number, number] = [near(b2[0]), b2[1]];

  const d1 = ccw(pb1, pb2, pa1);
  const d2 = ccw(pb1, pb2, pa2);
  const d3 = ccw(pa1, pa2, pb1);
  const d4 = ccw(pa1, pa2, pb2);

  if (((d1 > 1e-12 && d2 < -1e-12) || (d1 < -1e-12 && d2 > 1e-12)) &&
      ((d3 > 1e-12 && d4 < -1e-12) || (d3 < -1e-12 && d4 > 1e-12))) {
    return true;
  }
  if (Math.abs(d1) <= 1e-12 && onSegment(pa1, pb1, pb2)) return true;
  if (Math.abs(d2) <= 1e-12 && onSegment(pa2, pb1, pb2)) return true;
  if (Math.abs(d3) <= 1e-12 && onSegment(pb1, pa1, pa2)) return true;
  if (Math.abs(d4) <= 1e-12 && onSegment(pb2, pa1, pa2)) return true;
  return false;
};

/**
 * Computes the bounding box of any geometry.
 */
export const boundingBoxOf = (geometry: Geometry): BoundingBox => {
  const positions = positionsOf(geometry);
  if (positions.length === 0) return { west: 0, south: 0, east: 0, north: 0 };
  const first = positions[0]!;
  const anchor = first[0];
  const near = (v: number) => {
    const delta = v - anchor;
    return delta > 180 ? v - 360 : delta < -180 ? v + 360 : v;
  };
  let minLon = anchor;
  let maxLon = anchor;
  let south = first[1];
  let north = first[1];

  for (let i = 1; i < positions.length; i++) {
    const p = positions[i]!;
    const unwrappedLon = near(p[0]);
    if (unwrappedLon < minLon) minLon = unwrappedLon;
    if (unwrappedLon > maxLon) maxLon = unwrappedLon;
    if (p[1] < south) south = p[1];
    if (p[1] > north) north = p[1];
  }

  const norm = (v: number) => ((v + 180) % 360 + 360) % 360 - 180;
  return {
    west: norm(minLon),
    south,
    east: norm(maxLon),
    north,
  };
};

/**
 * Whether two bounding boxes overlap, accounting for antimeridian crossing.
 */
export const boundingBoxesOverlap = (a: BoundingBox, b: BoundingBox): boolean => {
  if (a.south > b.north || a.north < b.south) return false;
  const lonRanges = (box: BoundingBox): ReadonlyArray<readonly [number, number]> =>
    box.west <= box.east
      ? [[box.west, box.east]]
      : [[box.west, 180], [-180, box.east]];
  const aRanges = lonRanges(a);
  const bRanges = lonRanges(b);
  return aRanges.some(([wA, eA]) =>
    bRanges.some(([wB, eB]) => Math.max(wA, wB) <= Math.min(eA, eB)),
  );
};

/**
 * Returns all line segments of a geometry.
 */
const segmentsOf = (geometry: Geometry): Array<readonly [Position, Position]> => {
  const segments: Array<readonly [Position, Position]> = [];
  switch (geometry.type) {
    case "Point":
      break;
    case "LineString":
      for (let i = 0; i < geometry.coordinates.length - 1; i++) {
        segments.push([geometry.coordinates[i]!, geometry.coordinates[i + 1]!]);
      }
      break;
    case "MultiLineString":
      for (const line of geometry.coordinates) {
        for (let i = 0; i < line.length - 1; i++) {
          segments.push([line[i]!, line[i + 1]!]);
        }
      }
      break;
    case "Polygon":
      for (const ring of geometry.coordinates) {
        for (let i = 0; i < ring.length - 1; i++) {
          segments.push([ring[i]!, ring[i + 1]!]);
        }
      }
      break;
    case "MultiPolygon":
      for (const poly of geometry.coordinates) {
        for (const ring of poly) {
          for (let i = 0; i < ring.length - 1; i++) {
            segments.push([ring[i]!, ring[i + 1]!]);
          }
        }
      }
      break;
  }
  return segments;
};

/**
 * Whether two geometries intersect.
 *
 * Checks:
 * 1. Fast bounding-box overlap.
 * 2. Containment of any vertex of A in B, or any vertex of B in A.
 * 3. Edge-to-edge crossing of any segment in A with any segment in B,
 *    correctly detecting overlapping polygons and lines even when no
 *    vertex lies inside the other.
 */
export const intersectsGeometry = (a: Geometry, b: Geometry): boolean => {
  assertGeometryBudget(a);
  assertGeometryBudget(b);

  if (!boundingBoxesOverlap(boundingBoxOf(a), boundingBoxOf(b))) {
    return false;
  }

  // Points
  if (a.type === "Point" && b.type === "Point") {
    return a.coordinates[0] === b.coordinates[0] && a.coordinates[1] === b.coordinates[1];
  }
  if (a.type === "Point") return contains(b, a.coordinates);
  if (b.type === "Point") return contains(a, b.coordinates);

  // Check vertices containment:
  const positionsA = positionsOf(a);
  if (positionsA.some((pos) => contains(b, pos))) return true;

  const positionsB = positionsOf(b);
  if (positionsB.some((pos) => contains(a, pos))) return true;

  // Check segment-segment intersections:
  const segsA = segmentsOf(a);
  const segsB = segmentsOf(b);
  for (const segA of segsA) {
    for (const segB of segsB) {
      if (segmentsIntersect(segA[0], segA[1], segB[0], segB[1])) {
        return true;
      }
    }
  }

  return false;
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
  assertGeometryBudget(geometry);
  if (geometry.type === "Point") {
    const [lon, lat] = geometry.coordinates;
    return { cells: [h3.latLngToCell(lat, lon, finest)], resolution: finest };
  }
  if (geometry.type === "LineString" || geometry.type === "MultiLineString") {
    const lines = geometry.type === "LineString" ? [geometry.coordinates] : geometry.coordinates;
    let best: ReadonlyArray<string> = [];
    let reached = COARSEST_RESOLUTION;
    for (let resolution = COARSEST_RESOLUTION; resolution <= finest; resolution++) {
      const cells = new Set<string>();
      const edge = h3.getHexagonEdgeLengthAvg(resolution, "m");
      const step = Math.max(1, edge * 0.75);
      for (const line of lines) {
        for (let i = 0; i < line.length - 1; i++) {
          const p1 = line[i]!;
          const p2 = line[i + 1]!;
          const dist = distanceBetween(p1, p2);
          const intervals = Math.max(1, Math.ceil(dist / step));
          const anchor = p1[0];
          const near = (v: number) => {
            const delta = v - anchor;
            return delta > 180 ? v - 360 : delta < -180 ? v + 360 : v;
          };
          const p2Lon = near(p2[0]);
          for (let k = 0; k <= intervals; k++) {
            const t = k / intervals;
            const lat = p1[1] + t * (p2[1] - p1[1]);
            let lon = p1[0] + t * (p2Lon - p1[0]);
            if (lon > 180) lon -= 360;
            else if (lon < -180) lon += 360;
            cells.add(h3.latLngToCell(lat, lon, resolution));
          }
        }
        for (const pos of line) {
          cells.add(h3.latLngToCell(pos[1], pos[0], resolution));
        }
      }
      if (cells.size > MAX_COVERING) break;
      best = [...cells];
      reached = resolution;
    }
    return { cells: best, resolution: reached };
  }
  const polygons: ReadonlyArray<ReadonlyArray<Ring>> =
    geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
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
  assertGeometryBudget(geometry);
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
  if (geometry.type === "LineString" || geometry.type === "MultiLineString") {
    const lines = geometry.type === "LineString" ? [geometry.coordinates] : geometry.coordinates;
    const edge = h3.getHexagonEdgeLengthAvg(resolution, "m");
    const step = Math.max(1, edge * 0.75);
    for (const line of lines) {
      for (let i = 0; i < line.length - 1; i++) {
        const p1 = line[i]!;
        const p2 = line[i + 1]!;
        const dist = distanceBetween(p1, p2);
        const intervals = Math.max(1, Math.ceil(dist / step));
        const anchor = p1[0];
        const near = (v: number) => {
          const delta = v - anchor;
          return delta > 180 ? v - 360 : delta < -180 ? v + 360 : v;
        };
        const p2Lon = near(p2[0]);
        for (let k = 0; k <= intervals; k++) {
          const t = k / intervals;
          const lat = p1[1] + t * (p2[1] - p1[1]);
          let lon = p1[0] + t * (p2Lon - p1[0]);
          if (lon > 180) lon -= 360;
          else if (lon < -180) lon += 360;
          add(h3.latLngToCell(lat, lon, resolution));
        }
      }
      for (const pos of line) {
        add(h3.latLngToCell(pos[1], pos[0], resolution));
      }
    }
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
