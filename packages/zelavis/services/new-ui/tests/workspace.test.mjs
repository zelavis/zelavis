import test from "node:test";
import assert from "node:assert/strict";
import { installWorkspaceBridge, hasWorkspaceRoute, workspacePath } from "../app/workspace-island.ts";
import { workspaceRouteCatalog } from "../app/workspace-route-manifest.ts";

test("legacy sidebar writes and shell footer writes have the same canonical workspace URL", () => {
  const page = "http://local/zelavis/projects/p/database?workspaceMode=full&databaseTable=articles";
  assert.equal(workspacePath(new URL(page + "&sidebar=Backend%2FDatabase")), workspacePath(new URL(page + "&sidebarUtility=search&workspaceIsland=1")));
});

test("every original page has a workspace mapping; resource and catch-all are separate", () => {
  for (const route of workspaceRouteCatalog) {
    const path = route.path.replace(/:[^/]+/g, "fixture");
    assert.equal(hasWorkspaceRoute(path), !["/*", "/_api/relations/:collection"].includes(route.path), route.file);
  }
  assert.equal(hasWorkspaceRoute("/server/unknown/nested"), false);
});

test("workspace URL synchronization strips presentation state and authenticates both origin and source", () => {
  let message, changed, context = 0;
  const posts = [];
  const source = { postMessage: (...args) => posts.push(args) };
  const window = { location: { origin: "http://local" }, addEventListener: (_name, callback) => { message = callback; }, removeEventListener: () => { message = undefined; } };
  const router = { url: () => "http://local/zelavis/projects/p/content/a?entry=1&sidebar=projects&sidebarUtility=search", subscribeUrl: callback => { changed = callback; return () => { changed = undefined; }; }, navigate: () => { throw new Error("Untrusted navigation escaped"); } };
  const host = { ownerDocument: { defaultView: window }, querySelector: () => ({ contentWindow: source }) };
  const bridge = installWorkspaceBridge(host, router, () => { context++; });
  bridge.sync();
  assert.deepEqual(posts[0], [{ type: "newui:workspace-url", path: "/projects/p/content/a?entry=1" }, "http://local"]);
  message({ source: {}, origin: "http://local", data: { type: "newui:workspace-context" } });
  message({ source, origin: "https://foreign", data: { type: "newui:workspace-context" } });
  assert.equal(context, 0);
  message({ source, origin: "http://local", data: { type: "newui:workspace-context" } });
  assert.equal(context, 1);
  for (const path of ["//foreign/path", "../escape", "/../escape"]) message({ source, origin: "http://local", data: { type: "newui:workspace-navigation", path } });
  bridge.dispose();
  assert.equal(message, undefined); assert.equal(changed, undefined);
});
