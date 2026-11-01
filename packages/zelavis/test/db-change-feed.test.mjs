// The change feed answers what was written since a cursor at a cost of the changes, with memory fixed by its ring.
import assert from "node:assert/strict";
import test from "node:test";
import { makeChangeFeed } from "../dist/db/change-feed.js";

test("a fresh cursor asks for a resync, then only what changed is named, each partition once, oldest first", () => {
  const feed = makeChangeFeed({ epoch: "e1" });
  const first = feed.since(undefined);
  assert.equal(first.resync, true);
  feed.touch("a"); feed.touch("b"); feed.touch("a"); feed.touch("c");
  const answer = feed.since(first.cursor);
  assert.deepEqual(answer.partitions, ["b", "a", "c"], "a is named once, at its latest touch");
  assert.equal(answer.resync, false);
  assert.deepEqual(feed.since(answer.cursor).partitions, [], "nothing new");
  feed.touch("b");
  assert.deepEqual(feed.since(answer.cursor).partitions, ["b"]);
  assert.deepEqual(feed.since(answer.cursor, { only: new Set(["z"]) }).partitions, [], "only what was asked about");
});

test("a page is bounded, continues exactly where it stopped, and a cursor from another life resyncs", () => {
  const feed = makeChangeFeed({ epoch: "e1" });
  const start = feed.since(undefined).cursor;
  for (let at = 0; at < 2500; at++) feed.touch(`t${at}`);
  const seen = [];
  let cursor = start;
  for (let pages = 0; ; pages++) {
    const answer = feed.since(cursor, { limit: 1000 });
    assert.ok(answer.partitions.length <= 1000);
    seen.push(...answer.partitions);
    cursor = answer.cursor;
    if (!answer.more) break;
    assert.ok(pages < 10);
  }
  assert.equal(seen.length, 2500);
  assert.equal(new Set(seen).size, 2500, "every touched partition exactly once across the pages");
  assert.equal(feed.since({ epoch: "other", seq: 5 }).resync, true);
  assert.equal(feed.since({ epoch: "e1", seq: 99_999 }).resync, true, "a cursor from the future cannot be honoured");
});

test("the ring is fixed: memory stays bounded however many partitions are written, and a follower further behind resyncs", () => {
  const feed = makeChangeFeed({ epoch: "e1", ring: 100 });
  const behind = feed.since(undefined).cursor;
  for (let at = 0; at < 100_000; at++) feed.touch(`tenant-${at}`);
  assert.equal(feed.since(behind).resync, true, "the ring no longer reaches that far back");
  const near = feed.since(undefined).cursor;
  for (let at = 0; at < 50; at++) feed.touch(`fresh-${at}`);
  const answer = feed.since(near);
  assert.equal(answer.resync, false);
  assert.equal(answer.partitions.length, 50);
});
