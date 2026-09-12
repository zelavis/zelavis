// Joining through a reference against doing it by hand.
//
//   POSTS=20000 AUTHORS=2000 node scripts/bench-related.mjs
//
// A related clause answers the target's query and turns its ids into an
// equality union over the referencing field's postings. The alternative a
// caller has without it is to read the referencing collection and filter in
// memory, which costs the collection rather than the answer.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Effect } from "effect";
import { documentsFor } from "../dist/db/index.js";
import { makeNodeSqliteStore } from "../dist/db/engines/node-sqlite.js";

const POSTS = Number(process.env.POSTS ?? 20000);
const AUTHORS = Number(process.env.AUTHORS ?? 2000);
const COUNTRIES = 10;

const median = async (runs, fn) => {
  const times = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    await fn();
    times.push(performance.now() - t);
  }
  return times.sort((a, b) => a - b)[Math.floor(runs / 2)];
};

const dir = mkdtempSync(join(tmpdir(), "zv-bench-related-"));
try {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const docs = documentsFor(yield* makeNodeSqliteStore("bench", dir), "t1");
    yield* docs.createCollection({ name: "authors" });
    yield* docs.createCollection({
      name: "posts", references: [{ name: "author", path: "authorId", collection: "authors" }],
    });
    for (let i = 0; i < AUTHORS; i++) {
      yield* docs.insert({ collection: "authors", id: `a${i}`, data: { country: `c${i % COUNTRIES}` } });
    }
    for (let i = 0; i < POSTS; i++) {
      yield* docs.insert({ collection: "posts", id: `p${i}`, data: { authorId: `a${i % AUTHORS}`, rank: i } });
    }

    const related = [{ reference: "author", where: [{ path: "country", value: "c7" }] }];
    const byHand = Effect.gen(function* () {
      const posts = yield* docs.findMany({ collection: "posts" });
      const resolved = yield* docs.withRelated({ collection: "posts", documents: posts });
      return resolved.filter((entry) => entry.related.author?.data.country === "c7").map((entry) => entry.document);
    });
    const run = (effect) => () => Effect.runPromise(effect);
    const matched = (yield* docs.findMany({ collection: "posts", related })).length;

    const rows = [
      [`related: authors in one country (${matched} of ${POSTS} posts)`, run(docs.findMany({ collection: "posts", related }))],
      ["the same by hand: every post, resolved and filtered", run(byHand)],
      ["related: one author by id", run(docs.findMany({ collection: "posts", related: [{ reference: "author", id: "a7" }] }))],
      ["a page of 50 of that join", run(docs.findPage({ collection: "posts", related, limit: 50 }))],
    ];
    console.log(`\nOver ${POSTS} posts across ${AUTHORS} authors (node:sqlite, median of 5, warm)`);
    for (const [label, fn] of rows) {
      console.log(`  ${label.padEnd(54)} ${(yield* Effect.promise(() => median(5, fn))).toFixed(1).padStart(8)}ms`);
    }
    const page = yield* docs.findPage({ collection: "posts", limit: 50 });
    const resolving = yield* Effect.promise(() => median(5, run(
      docs.withRelated({ collection: "posts", documents: page.documents }))));
    console.log(`  ${"withRelated over a page of 50".padEnd(54)} ${resolving.toFixed(1).padStart(8)}ms`);
  })));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
