import assert from "node:assert/strict";
import test from "node:test";

import { listSetupValues, parseRecipeManifest } from "../dist/core/recipe/index.js";

const base = { contract: 1, methods: [{ id: "native", driver: "js", entry: "./dist/r.mjs", requires: [] }], software: [{ version: "1.0", archive: "https://example.com/a.tgz", sha256: "a".repeat(64), maxBytes: 10 }], ports: [{ name: "db", protocol: "tcp" }], directories: [{ name: "site", path: "site" }] };
const parse = (setup) => parseRecipeManifest({ ...base, setup });
const source = { ports: { db: 3307 }, directories: { site: "/p/app/site" }, root: "/p/app", sockets: "/run/zv", user: "www" };

test("setup values are templates over the Project's ports, directories, sockets and account, and secrets only when revealed", () => {
  const manifest = parse([
    { id: "host", label: "Database host", value: "127.0.0.1:{ports.db}" },
    { id: "socket", label: "Socket", value: "{sockets}/mariadb.sock" },
    { id: "user", label: "Database user", value: "{user}" },
    { id: "site", label: "Site folder", value: "{dir.site}" },
    { id: "password", label: "Database password", value: "{secret.db-password}" },
  ]);
  const listed = listSetupValues(manifest, source);
  assert.deepEqual(listed.map((entry) => [entry.id, entry.secret, entry.value]), [
    ["host", false, "127.0.0.1:3307"], ["socket", false, "/run/zv/mariadb.sock"], ["user", false, "www"], ["site", false, "/p/app/site"], ["password", true, undefined],
  ]);
  const revealed = listSetupValues(manifest, source, { "db-password": "s3cret" });
  assert.equal(revealed.find((entry) => entry.id === "password").value, "s3cret");
  assert.equal(revealed.find((entry) => entry.id === "host").value, "127.0.0.1:3307");
});

test("a template naming something the recipe does not declare, or a token the contract does not define, is refused when the recipe loads", () => {
  for (const bad of [
    [{ id: "a", label: "A", value: "{ports.web}" }],
    [{ id: "a", label: "A", value: "{dir.nowhere}" }],
    [{ id: "a", label: "A", value: "{env.HOME}" }],
    [{ id: "a", label: "A", value: "{secret.x" }],
    [{ id: "a", label: "A", value: "x" }, { id: "a", label: "B", value: "y" }],
  ]) assert.throws(() => parse(bad), undefined, JSON.stringify(bad));
});

test("a value the Project cannot fill is an error, never a guess", () => {
  const manifest = parse([{ id: "password", label: "Password", value: "{secret.missing}" }]);
  assert.throws(() => listSetupValues(manifest, source, {}), /cannot be filled/);
});
