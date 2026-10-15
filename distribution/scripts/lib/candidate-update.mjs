// Updates an installed Platform to the packed candidate (/input/zelavis.tgz) through the installed release's own
// updater: only the unavailable registry acquisition is substituted, so request coordination, staging and the live
// handover are the release's real code. Used by the update gate and the long-history gate.
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
async function run(command, args) {
  try { const result = await execute(command, args, { maxBuffer: 16 * 1024 * 1024, timeout: 300_000 }); return { code: 0, output: result.stdout + result.stderr }; }
  catch (error) { return { code: typeof error.code === 'number' ? error.code : 1, output: String(error.stdout ?? '') + String(error.stderr ?? '') + error.message }; }
}
const load = (root, file) => import(pathToFileURL(join(root, 'platform/dist', file)));

/** `previous` is the installed release directory, `to` the candidate's version, `baseUrl` the Platform's address. */
export async function updateToLocalCandidate({ previous, to, baseUrl }) {
  // Before publication, substitute only the unavailable registry acquisition.
  // Request coordination and execution come from the actual installed previous release.
  execFileSync('systemctl', ['stop', 'zelavis-update.path']);
  const { createNodeUpdateControl } = await load(previous, 'adapters/_node-updates.js');
  const control = createNodeUpdateControl({ dataDirectory: '/var/lib/zelavis', schedule: false,
    fetch: async () => Response.json({ alpha: to }) });
  await control.check(); await control.apply("qualification-owner");
  const { runUpdate } = await load(previous, 'adapters/_update-runner.js');
  const result = await runUpdate({ prefix: '/opt/zelavis', dataDirectory: '/var/lib/zelavis', channelVersion: async () => to,
    healthy: async () => (await fetch(`${baseUrl}/zelavis/api/v1/auth/bootstrap`)).ok,
    sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    run: async (command, args) => {
      if (command !== 'sh') return run(command, args);
      assert.deepEqual(args, [join(previous, 'platform/dist/installation-assets/install.sh'), '--version', to, '--stage-only']);
      const tree = '/opt/update-candidate';
      const npmRoot = '/opt/update-npm';
      await mkdir(join(tree, 'runtime'), { recursive: true }); await mkdir(npmRoot);
      await writeFile(join(npmRoot, 'package.json'), '{"private":true}');
      await cp(join(previous, 'runtime/node'), join(tree, 'runtime/node'), { recursive: true, verbatimSymlinks: true });
      const node = join(tree, 'runtime/node/bin/node');
      const installed = await run(node, [join(tree, 'runtime/node/lib/node_modules/npm/bin/npm-cli.js'), 'install', '--prefix', npmRoot,
        '--registry=https://registry.npmjs.org', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', '/input/zelavis.tgz']);
      if (installed.code) return installed;
      await rename(join(npmRoot, 'node_modules/zelavis'), join(tree, 'platform'));
      await rename(join(npmRoot, 'node_modules'), join(tree, 'platform/node_modules'));
      execFileSync('ln', ['-s', '..', join(tree, 'platform/node_modules/zelavis')]);
      const pin = JSON.parse(await readFile(join(tree, 'platform/dist/installation-assets/release.json'), 'utf8')).nodeVersion;
      assert.match(pin, /^\d+\.\d+\.\d+$/);
      if (`v${pin}` !== execFileSync(node, ['--version'], { encoding: 'utf8' }).trim()) {
        const name = `node-v${pin}-linux-${process.arch}`;
        const archive = `/opt/${name}.tar.gz`, checksums = `/opt/${name}.checksums`;
        for (const [remote, destination, bound] of [[`${name}.tar.gz`, archive, '268435456'], ['SHASUMS256.txt', checksums, '1048576']]) {
          const fetched = await run('curl', ['--proto', '=https', '--fail', '--silent', '--show-error', '--max-time', '600', '--max-filesize', bound,
            `https://nodejs.org/dist/v${pin}/${remote}`, '-o', destination]);
          assert.equal(fetched.code, 0, fetched.output);
        }
        const expected = (await readFile(checksums, 'utf8')).split('\n').find(line => line.endsWith(`  ${name}.tar.gz`))?.split(' ')[0];
        assert.match(expected ?? '', /^[a-f0-9]{64}$/);
        assert.equal(createHash('sha256').update(await readFile(archive)).digest('hex'), expected);
        const members = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim().split('\n');
        assert.ok(members.every(member => (member === name || member.startsWith(`${name}/`)) && !member.split('/').includes('..')));
        await rm(join(tree, 'runtime/node'), { recursive: true });
        execFileSync('tar', ['--no-same-owner', '-xzf', archive, '-C', join(tree, 'runtime')]);
        await rename(join(tree, 'runtime', name), join(tree, 'runtime/node'));
      }
      return run(node, [join(tree, 'platform/dist/cli.js'), 'install', '--from-npm', tree, '--stage-only']);
    } });
  assert.equal(result.state, 'succeeded', JSON.stringify(result));
  execFileSync('systemctl', ['start', 'zelavis-update.path']);
}
