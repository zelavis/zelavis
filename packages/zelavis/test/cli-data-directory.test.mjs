import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import test from "node:test";

import {
  defaultCliDataDirectory,
  resolveCliDataDirectory,
} from "../dist/cli/data-directory.js";

function withEnv(t, values) {
  const saved = new Map();
  for (const [key, value] of Object.entries(values)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("the default is the user's data directory, not the current one", (t) => {
  withEnv(t, { XDG_DATA_HOME: undefined });
  assert.equal(defaultCliDataDirectory(), join(homedir(), ".local", "share", "zelavis"));
});

test("an explicit directory always wins over the default", (t) => {
  withEnv(t, { XDG_DATA_HOME: "/xdg" });
  assert.equal(resolveCliDataDirectory("/var/lib/zelavis"), "/var/lib/zelavis");
  // This is the packaged path: the systemd units name ZELAVIS_DATA_DIR, the
  // caller resolves it, and it must reach here untouched.
  assert.equal(resolveCliDataDirectory("/srv/data"), "/srv/data");
});

test("XDG_DATA_HOME is honoured when absolute", (t) => {
  withEnv(t, { XDG_DATA_HOME: "/xdg/share" });
  assert.equal(defaultCliDataDirectory(), join("/xdg/share", "zelavis"));
});

test("a relative or blank XDG_DATA_HOME is ignored, as the spec requires", (t) => {
  for (const value of ["relative/share", "   ", ""]) {
    withEnv(t, { XDG_DATA_HOME: value });
    assert.equal(
      defaultCliDataDirectory(),
      join(homedir(), ".local", "share", "zelavis"),
      `XDG_DATA_HOME=${JSON.stringify(value)} should have been ignored`,
    );
  }
});

test("the result is always absolute, so cd cannot change which Platform is served", (t) => {
  withEnv(t, { XDG_DATA_HOME: undefined });
  for (const explicit of [undefined, "", "   ", "relative/dir"]) {
    assert.equal(isAbsolute(resolveCliDataDirectory(explicit)), true, String(explicit));
  }
});

test("a blank explicit value falls back rather than resolving to the working directory", (t) => {
  withEnv(t, { XDG_DATA_HOME: "/xdg" });
  // The regression this guards: `resolve("")` is the current directory, so an
  // empty --data-dir or ZELAVIS_DATA_DIR would silently mean "here".
  assert.equal(resolveCliDataDirectory(""), join("/xdg", "zelavis"));
  assert.equal(resolveCliDataDirectory("   "), join("/xdg", "zelavis"));
  assert.notEqual(resolveCliDataDirectory(""), process.cwd());
});
