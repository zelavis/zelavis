/**
 * The layout this code writes. A shard carries it so a layout change is caught
 * on open instead of misread.
 *
 * 5: an event cursor names the life of the partition that issued it, and a
 * branch's lineage the life of each ancestor, so a cursor kept from before a
 * Tenant was removed and written again is refused instead of skipping the new
 * life's events up to its old position. Cursors are kept inside the data
 * (projection checkpoints, time-series state), so the encoding is the layout's.
 *
 * A leaf module: a Project's persistent host checks an engine's declared format without loading the store.
 */
export const CURRENT_FORMAT = 5;
