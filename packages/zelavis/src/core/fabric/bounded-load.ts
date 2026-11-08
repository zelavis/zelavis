/**
 * Consistent hashing with bounded loads (Mirrokni, Thorup, Zadimoghaddam, "Consistent Hashing with Bounded Loads"): a key
 * goes to the first Node around a ring of virtual points whose load is under a cap, so placements spread, follow capacity
 * weights, and move little when Nodes come and go. It only proposes: the Platform Fabric commits a proposal as a versioned,
 * fenced record, and a recorded placement is never moved by asking again.
 *
 * Pure and deterministic, so the same input gives the same Node on every host: no clock, no randomness, no host hash.
 */

export interface BoundedLoadNode {
  readonly id: string;
  /** Capacity weight; rounded and clamped to 1–8. */
  readonly weight: number;
  /** Placements the Node already holds for this group. */
  readonly load: number;
}

export const BOUNDED_LOAD_FACTOR = 1.25;
export const BOUNDED_LOAD_POINTS_PER_WEIGHT = 64;
export const BOUNDED_LOAD_MAX_WEIGHT = 8;

/** FNV-1a, 32 bits, over the string's UTF-16 code units. Small, pure, and enough spread for ring placement. */
const hash = (value: string): number => {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193) >>> 0;
  }
  return result >>> 0;
};

const clampedWeight = (weight: number): number => Math.min(BOUNDED_LOAD_MAX_WEIGHT, Math.max(1, Math.round(weight)));

/** The Node `key` goes to; `undefined` only when there are no Nodes. */
export function proposeBoundedLoadNode(key: string, nodes: readonly BoundedLoadNode[]): string | undefined {
  const seen = new Set<string>();
  for (const node of nodes) {
    if (typeof node.id !== "string" || node.id.length === 0) throw new TypeError("A Node id is a non-empty string.");
    if (seen.has(node.id)) throw new TypeError(`Node "${node.id}" appears twice.`);
    seen.add(node.id);
    if (!Number.isSafeInteger(node.load) || node.load < 0) throw new TypeError(`Node "${node.id}" has an invalid load.`);
    if (!Number.isFinite(node.weight)) throw new TypeError(`Node "${node.id}" has an invalid weight.`);
  }
  if (nodes.length === 0) return undefined;

  const weights = new Map(nodes.map((node) => [node.id, clampedWeight(node.weight)]));
  const totalWeight = [...weights.values()].reduce((sum, weight) => sum + weight, 0);
  const totalLoad = nodes.reduce((sum, node) => sum + node.load, 0);
  const capOf = (id: string): number => Math.ceil(BOUNDED_LOAD_FACTOR * (totalLoad + 1) * weights.get(id)! / totalWeight);
  const loads = new Map(nodes.map((node) => [node.id, node.load]));

  const ring: { readonly point: number; readonly id: string }[] = [];
  for (const node of nodes) {
    const points = BOUNDED_LOAD_POINTS_PER_WEIGHT * weights.get(node.id)!;
    for (let virtual = 0; virtual < points; virtual += 1) ring.push({ point: hash(`${node.id}#${virtual}`), id: node.id });
  }
  // By point, then by id with a plain comparison: the same order whatever order the Nodes were given in.
  ring.sort((left, right) => left.point - right.point || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

  const wanted = hash(key);
  let low = 0;
  let high = ring.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (ring[middle]!.point < wanted) low = middle + 1;
    else high = middle;
  }
  // At most one turn of the ring: the caps sum to more than the load plus this placement, so some Node has room.
  for (let step = 0; step < ring.length; step += 1) {
    const { id } = ring[(low + step) % ring.length]!;
    if (loads.get(id)! < capOf(id)) return id;
  }
  return undefined;
}
