import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMemorySystemStore, zelavis } from "../dist/index.js";
import { runAuthCommand } from "../dist/cli/auth.js";
import { createZelavisClient } from "../dist/sdk/fetch.js";

test("HTTP, SDK and CLI agree on account import and the CLI refreshes its saved session", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const bootstrapToken = "account-import-bootstrap-token-32-chars";
  const runtime = await zelavis({
    systemStore: createMemorySystemStore(),
    bootstrap: { token: bootstrapToken },
    subsystems: { auth: { ttl: { accessTokenTtlSeconds: 60 } } },
  });
  const directory = await mkdtemp(join(tmpdir(), "zelavis-cli-auth-"));
  t.after(() => runtime.close());
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, "session.sqlite");
  const baseUrl = "http://localhost";
  let refreshes = 0;
  const through = (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname.endsWith("/auth/session/refresh")) refreshes += 1;
    return runtime.fetch(request);
  };
  t.mock.method(globalThis, "fetch", through);
  const logs = [];
  t.mock.method(console, "log", line => { logs.push(line); });
  const cli = async (args) => {
    await runAuthCommand([...args, "--url", baseUrl + "/zelavis", "--session-file", filename, "--json"]);
    return JSON.parse(logs.pop());
  };
  const claimed = await cli(["bootstrap", "claim", "--data", JSON.stringify({
    bootstrapToken, username: "owner", password: "paper lantern holds a cloud",
  })]);
  assert.equal(claimed.status, "complete");
  assert.equal((await stat(filename)).mode & 0o777, 0o600);
  const body = { accounts: [{ email: "one@example.com" }, { username: "two" }], dryRun: true };
  const headers = { authorization: `Bearer ${claimed.tokens.accessToken}`, "content-type": "application/json" };
  const response = await through(baseUrl + "/zelavis/api/v1/auth/accounts/import", { method: "POST", headers, body: JSON.stringify(body) });
  assert.equal(response.status, 200);
  const http = await response.json();
  const sdk = createZelavisClient({ baseUrl, headers, fetch: through });
  assert.deepEqual(await sdk.auth.admin.importAccounts(body), http);
  now += 61_000;
  assert.deepEqual(await cli(["admin", "import-accounts", "--data", JSON.stringify(body)]), http);
  assert.equal((await cli(["session", "current"])).account.id, claimed.userId);
  assert.equal(refreshes, 1);
  assert.deepEqual(await cli(["session", "sign-out"]), { signedOut: true });
  await assert.rejects(cli(["session", "current"]), { status: 401 });
});
