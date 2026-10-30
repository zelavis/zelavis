// Keep an analytics copy of one Tenant's documents current from its export stream.
//
// The stream (`client.projects.exportTenantPage`, `zelavis projects export-stream`) gives a Tenant's records and then
// every change since, in pages. Applying entries by version leaves a table that, once a page says `consistent`, is
// the Tenant as of one log position, and the same cursor goes on delivering changes from there. This file is that
// consumer with nothing else in it: it takes the client as an argument, keeps its state as plain JSON you can save
// between runs, and turns the table into rows for whatever loads them (DuckDB `read_json`, ClickHouse `JSONEachRow`,
// a warehouse's bulk loader). Nothing here is a Zelavis dependency, and no analytics engine is built into Zelavis.

/** The state a feed keeps: apply this, save it as JSON, hand it back later to carry on. */
export const emptyFeed = () => ({ cursor: undefined, records: {} });

/**
 * Apply one page's entries by version: an entry older than what is held changes nothing, a newer one brings the
 * record forward, and a retraction leaves the record's version behind so a late repeat cannot bring it back.
 */
export function apply(feed, entries) {
  for (const entry of entries) {
    const key = entry.part === undefined ? String(entry.seq) : `${entry.part}:${entry.seq}`;
    const held = feed.records[key];
    if (held !== undefined && held.version >= entry.version) continue;
    feed.records[key] = entry.kind === "put"
      ? { version: entry.version, identity: entry.identity, body: entry.body, part: entry.part }
      : { version: entry.version, retracted: true };
  }
}

/** The documents the feed holds as flat rows: one per live document, with its collection and Tenant part. */
export function rows(feed) {
  const out = [];
  for (const record of Object.values(feed.records)) {
    if (record.retracted || !record.identity?.namespace.startsWith("doc/")) continue;
    const document = JSON.parse(Buffer.from(record.body, "base64").toString("utf8"));
    out.push({ ...(record.part === undefined ? {} : { part: record.part }), collection: document.collection, id: document.id, version: document.version, ...document.data });
  }
  return out.sort((a, b) => `${a.part ?? ""}/${a.collection}/${a.id}`.localeCompare(`${b.part ?? ""}/${b.collection}/${b.id}`));
}

/** Rows as JSON lines, what most analytics loaders read. */
export const jsonLines = (feed) => rows(feed).map((row) => JSON.stringify(row)).join("\n");

/**
 * Read pages until the feed is consistent, or, with `follow`, until `signal` aborts, waiting `pollMillis` whenever a
 * page brings nothing. `onPage(feed, page)` runs after each page is applied: save the feed there to survive a
 * restart.
 *
 * A cursor the log has outrun (the Tenant's log was compacted past it while the consumer was away) or from before
 * the Tenant was removed and written again cannot continue: the feed starts over from a new export, which is the
 * same stream's beginning, and never guesses at what it missed.
 */
export async function sync({ client, projectId, tenantId, feed = emptyFeed(), limit, follow = false, pollMillis = 1000, signal, onPage }) {
  let restarted = 0;
  for (;;) {
    let page;
    try {
      page = await client.projects.exportTenantPage(projectId, { tenantId, ...(feed.cursor === undefined ? {} : { cursor: feed.cursor }), ...(limit === undefined ? {} : { limit }) });
    } catch (error) {
      const lost = error?.response?.status === 409 || /removed and written again|belongs to another Tenant|not one an export gave/.test(String(error?.message));
      if (!lost || feed.cursor === undefined || restarted > 3) throw error;
      restarted += 1;
      feed.cursor = undefined;
      feed.records = {};
      continue;
    }
    apply(feed, page.entries);
    feed.cursor = page.cursor;
    await onPage?.(feed, page);
    if (page.consistent && !follow) return feed;
    if (page.consistent && page.entries.length === 0) {
      if (signal?.aborted) return feed;
      await new Promise((resolve) => setTimeout(resolve, pollMillis));
    }
    if (signal?.aborted) return feed;
  }
}
