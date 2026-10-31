import type { Geometry, Position } from "./spatial.js";

/** Browser-safe GeoJSON validation, shared by schema forms and document indexing. */
export function geometryValue(value: unknown): Geometry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { type, coordinates } = value as { type?: unknown; coordinates?: unknown };
  const position = (p: unknown): p is Position => Array.isArray(p) && p.length === 2
    && typeof p[0] === "number" && Number.isFinite(p[0]) && p[0] >= -180 && p[0] <= 180
    && typeof p[1] === "number" && Number.isFinite(p[1]) && p[1] >= -90 && p[1] <= 90;
  const line = (points: unknown): points is ReadonlyArray<Position> =>
    Array.isArray(points) && points.length >= 2 && points.every(position);
  const ring = (points: unknown): points is ReadonlyArray<Position> => line(points) && points.length >= 4
    && points[0]![0] === points[points.length - 1]![0] && points[0]![1] === points[points.length - 1]![1];
  const polygon = (rings: unknown) => Array.isArray(rings) && rings.length > 0 && rings.every(ring);
  const valid = type === "Point" ? position(coordinates)
    : type === "LineString" ? line(coordinates)
      : type === "MultiLineString" ? Array.isArray(coordinates) && coordinates.length > 0 && coordinates.every(line)
        : type === "Polygon" ? polygon(coordinates)
          : type === "MultiPolygon" && Array.isArray(coordinates) && coordinates.length > 0 && coordinates.every(polygon);
  return valid ? value as Geometry : undefined;
}
