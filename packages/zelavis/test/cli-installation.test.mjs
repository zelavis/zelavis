import assert from "node:assert/strict";
import test from "node:test";

import {
  describeInstallation,
  formatInstallation,
} from "../dist/cli/installation.js";

test("a packaged release is recognised by its layout, not a fixed prefix", () => {
  const deb = describeInstallation("/opt/zelavis/releases/1.0.1-alpha.2/bin/zelavis");
  assert.equal(deb.kind, "packaged");
  assert.equal(deb.root, "/opt/zelavis");

  // ZELAVIS_PREFIX moves the whole tree, so the prefix cannot be hardcoded.
  const relocated = describeInstallation("/srv/zv/releases/9.9.9/bin/zelavis");
  assert.equal(relocated.kind, "packaged");
  assert.equal(relocated.root, "/srv/zv");
});

test("a global npm install is recognised and reports its package root", () => {
  const npm = describeInstallation("/usr/local/lib/node_modules/zelavis/dist/cli.js");
  assert.equal(npm.kind, "npm");
  assert.equal(npm.root, "/usr/local/lib/node_modules/zelavis");

  // nvm, fnm and a plain --prefix all put it somewhere else entirely.
  const nvm = describeInstallation(
    "/home/dev/.nvm/versions/node/v24.12.0/lib/node_modules/zelavis/dist/cli.js",
  );
  assert.equal(nvm.kind, "npm");
  assert.equal(nvm.root, "/home/dev/.nvm/versions/node/v24.12.0/lib/node_modules/zelavis");
});

test("a checkout is neither, and says so rather than guessing", () => {
  const source = describeInstallation("/home/dev/zelavis/packages/zelavis/dist/cli.js");
  assert.equal(source.kind, "source");
  assert.equal(source.root, undefined);
});

test("a nested node_modules resolves to the innermost zelavis package", () => {
  const nested = describeInstallation(
    "/app/node_modules/something/node_modules/zelavis/dist/cli.js",
  );
  assert.equal(nested.kind, "npm");
  assert.equal(nested.root, "/app/node_modules/something/node_modules/zelavis");
});

test("each kind formats to a line naming where it is", () => {
  assert.match(
    formatInstallation(describeInstallation("/opt/zelavis/releases/1.0.0/bin/zelavis")),
    /^packaged installation at \/opt\/zelavis$/u,
  );
  assert.match(
    formatInstallation(describeInstallation("/usr/local/lib/node_modules/zelavis/dist/cli.js")),
    /^npm installation at \/usr\/local\/lib\/node_modules\/zelavis$/u,
  );
  assert.match(
    formatInstallation(describeInstallation("/home/dev/zelavis/packages/zelavis/dist/cli.js")),
    /^running from source at \/home\/dev\/zelavis\/packages\/zelavis\/dist\/cli\.js$/u,
  );
});

test("the two installs this exists to tell apart are distinguishable", () => {
  // The whole point: same command name, same possible version, different copy.
  const packaged = describeInstallation("/opt/zelavis/releases/1.0.0/bin/zelavis");
  const npm = describeInstallation("/usr/local/lib/node_modules/zelavis/dist/cli.js");
  assert.notEqual(packaged.kind, npm.kind);
  assert.notEqual(formatInstallation(packaged), formatInstallation(npm));
});
