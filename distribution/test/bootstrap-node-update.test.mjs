import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
for (const malformed of [false, true]) test(`the installed bootstrap ${malformed ? "refuses a malformed candidate Node pin" : "acquires and verifies the candidate's changed Node pin before executing it"}`, async t => {
  const root = await mkdtemp(join(tmpdir(), "zelavis-bootstrap-node-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin"); await mkdir(bin);
  const targetPin = malformed ? "../../untrusted" : "24.13.0";
  const urls = {};
  const os = process.platform === "darwin" ? "darwin" : "linux";
  for (const pin of ["24.12.0", "24.13.0"]) {
    const name = `node-v${pin}-${os}-${process.arch}`, tree = join(root, name);
    await mkdir(join(tree, "bin"), { recursive: true });
    await mkdir(join(tree, "lib/node_modules/npm"), { recursive: true });
    await writeFile(join(tree, "bin/node"), `#!/bin/sh\nexport QUALIFIED_NODE_PIN=${pin}\nexec ${quote(process.execPath)} "$@"\n`, { mode: 0o755 });
    await mkdir(join(tree, "lib/node_modules/npm/bin"));
    await writeFile(join(tree, "lib/node_modules/npm/bin/npm-cli.js"), `
      const fs = require('node:fs'), path = require('node:path');
      if (!process.argv.includes('--ignore-scripts')) throw Error('Scripts must stay disabled');
      const prefix = process.argv[process.argv.indexOf('--prefix') + 1];
      const pkg = path.join(prefix, 'node_modules/zelavis');
      fs.mkdirSync(path.join(pkg, 'dist/installation-assets'), { recursive: true });
      fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'zelavis', version: '9.0.0' }));
      fs.writeFileSync(path.join(pkg, 'dist/installation-assets/release.json'), JSON.stringify({ nodeVersion: ${JSON.stringify(targetPin)} }));
      fs.writeFileSync(path.join(pkg, 'dist/cli.js'), "console.log('CANDIDATE_NODE=' + process.env.QUALIFIED_NODE_PIN); console.log(process.argv.slice(2).join(' '));");
    `);
    const archive = join(root, `${name}.tar.gz`);
    execFileSync("tar", ["-czf", archive, "-C", root, name]);
    const digest = createHash("sha256").update(await readFile(archive)).digest("hex");
    const sums = join(root, `${pin}.checksums`); await writeFile(sums, `${digest}  ${name}.tar.gz\n`);
    urls[`https://nodejs.org/dist/v${pin}/${name}.tar.gz`] = archive;
    urls[`https://nodejs.org/dist/v${pin}/SHASUMS256.txt`] = sums;
  }
  const curl = join(bin, "curl");
  await writeFile(curl, `#!${process.execPath}\nconst fs = require('node:fs'); const args = process.argv.slice(2); const urls = ${JSON.stringify(urls)}; const url = args.find(arg => arg.startsWith('https://')); if (!urls[url]) throw Error('Untrusted download ' + url); fs.copyFileSync(urls[url], args[args.indexOf('-o') + 1]);\n`);
  await chmod(curl, 0o755);
  const source = await readFile(new URL("../installers/install.sh", import.meta.url), "utf8");
  const fixture = join(root, "bootstrap.sh");
  // Only transport is replaced; run the complete authored shell flow, with
  // checksum verification, archive validation, npm script policy and private Node.
  await writeFile(fixture, source.replace('PATH=/usr/sbin:/usr/bin:/sbin:/bin', `PATH=${quote(bin)}:/usr/sbin:/usr/bin:/sbin:/bin`));
  const run = () => execFileSync("sh", [fixture, "--version", "9.0.0", "--user", "--stage-only"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (malformed) assert.throws(run, /Invalid release Node pin/);
  else {
    const output = run();
    assert.match(output, /CANDIDATE_NODE=24\.13\.0/);
    assert.match(output, /install --from-npm .*--user --stage-only/);
  }
});
