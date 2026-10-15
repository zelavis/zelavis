import test from "node:test";
import assert from "node:assert/strict";
import { mountOf, placeholderTransform, requestIntoBuild, responseOutOfBuild } from "../src/mount-rewrite.ts";

test("a mount is a root path without its trailing slash, and only well-formed ones are accepted", () => {
  assert.equal(mountOf("/zelavis"), "/zelavis");
  assert.equal(mountOf("/zelavis/"), "/zelavis");
  assert.equal(mountOf("/"), "");
  for (const bad of ["zelavis", "/a b", "/a?x", "/a/../b", "//x", "/__zelavis__", "", undefined]) assert.throws(() => mountOf(bad), bad);
});

test("requests enter the build under the placeholder and nothing outside the mount does", async () => {
  const inside = requestIntoBuild(new Request("http://h/admin/projects/p?x=1", { method: "POST", body: "payload", headers: { "content-type": "text/plain" } }), "/admin");
  assert.equal(new URL(inside.url).pathname, "/__zelavis__/projects/p");
  assert.equal(new URL(inside.url).search, "?x=1");
  assert.equal(await inside.text(), "payload");
  assert.equal(new URL(requestIntoBuild(new Request("http://h/admin"), "/admin").url).pathname, "/__zelavis__");
  assert.equal(requestIntoBuild(new Request("http://h/administrator"), "/admin"), undefined, "a longer name is not the mount");
  assert.equal(requestIntoBuild(new Request("http://h/other"), "/admin"), undefined);
  assert.equal(new URL(requestIntoBuild(new Request("http://h/projects/p"), "").url).pathname, "/__zelavis__/projects/p");
});

test("a server view asked for by its page address is asked for it under the placeholder", () => {
  const asked = (request, mount) => new URL(request.url).searchParams.get("url");
  const render = (mount, target) => requestIntoBuild(new Request(`http://h${mount}/_fuzor/render?url=${encodeURIComponent(target)}`), mount);
  assert.equal(asked(render("/admin", "/admin/projects/p/database?x=1&y=2"), "/admin"), "/__zelavis__/projects/p/database?x=1&y=2");
  assert.equal(asked(render("", "/projects/p/database?x=1"), ""), "/__zelavis__/projects/p/database?x=1");
  assert.equal(asked(render("/admin", "/elsewhere/x"), "/admin"), "/elsewhere/x", "a page outside the mount is left for Fuzor to refuse");
  const other = requestIntoBuild(new Request("http://h/admin/api/v1/runtime?url=/admin/x"), "/admin");
  assert.equal(new URL(other.url).searchParams.get("url"), "/admin/x", "only the render endpoint's address is rewritten");
});

test("the placeholder is replaced across chunk boundaries and a partial match is not lost", async () => {
  for (const mount of ["/zelavis", "/admin", ""]) {
    const text = 'href="/__zelavis__/assets/a.js" import("/__zelavis__/x") /__zelavis__ /__zel not-a-match "/__zelavis__/"';
    const expected = text.replaceAll("/__zelavis__", mount);
    for (const size of [1, 2, 3, 5, 7, 11, 100]) {
      const chunks = []; for (let index = 0; index < text.length; index += size) chunks.push(text.slice(index, index + size));
      const out = new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } }).pipeThrough(placeholderTransform(mount));
      let result = ""; for await (const piece of out) result += piece;
      assert.equal(result, expected, `${mount || "(root)"} in pieces of ${size}`);
    }
  }
});

test("a response keeps its status, drops what the rewrite invalidates, and leaves binary bodies alone", async () => {
  const html = new Response('<a href="/__zelavis__/x">x</a>', { status: 404, headers: { "content-type": "text/html; charset=utf-8", "content-length": "30", etag: '"a"', location: "/__zelavis__/login" } });
  const out = responseOutOfBuild(html, "/admin");
  assert.equal(out.status, 404);
  assert.equal(await out.text(), '<a href="/admin/x">x</a>');
  assert.equal(out.headers.get("content-length"), null);
  assert.equal(out.headers.get("etag"), null);
  assert.equal(out.headers.get("location"), "/admin/login");
  const bytes = new Uint8Array([0x2f, 0x5f, 0x5f, 0xff, 0x00]);
  const binary = responseOutOfBuild(new Response(bytes, { headers: { "content-type": "font/woff2" } }), "/admin");
  assert.deepEqual(new Uint8Array(await binary.arrayBuffer()), bytes);
});
