import assert from "node:assert/strict";
import test from "node:test";
import { parseFrames } from "../app/sse.ts";

test("frames end at a blank line and a partial frame waits for the rest", () => {
  const first = parseFrames('event: text\ndata: {"delta":"Hel"}\n\nevent: text\ndata: {"del');
  assert.deepEqual(first.frames, [{ event: "text", data: { delta: "Hel" } }]);
  const second = parseFrames(first.rest + 'ta":"lo"}\n\n');
  assert.deepEqual(second.frames, [{ event: "text", data: { delta: "lo" } }]);
  assert.equal(second.rest, "");
});

test("a final frame without its blank line is still read, and a malformed one fails loudly", () => {
  assert.deepEqual(parseFrames('event: done\ndata: {"ok":true}', true).frames, [{ event: "done", data: { ok: true } }]);
  assert.throws(() => parseFrames("event: text\ndata: {nope\n\n"), /malformed/);
});
