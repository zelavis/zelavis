/** A real previous npm release in disposable Debian/systemd; no host mutations outside it. */
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
if (process.env.ZELAVIS_PROVISIONING_DISPOSABLE !== '1' || process.getuid() !== 0) throw Error('Disposable root qualification only');
await readFile('/.dockerenv');
const mode = process.env.ZELAVIS_QUALIFY_UPDATE;
assert.ok(['local', 'npm'].includes(mode));
const previous = await realpath('/opt/zelavis/current');
const from = JSON.parse(await readFile(join(previous, 'manifest.json'), 'utf8')).version;
assert.equal(from, process.env.ZELAVIS_PROVISIONING_FROM_NPM);
const to = JSON.parse(await readFile('/workspace/packages/zelavis/package.json', 'utf8')).version;
assert.notEqual(from, to, 'Qualification needs an actual previous release');
const load = (root, file) => import(pathToFileURL(join(root, 'platform/dist', file)));
let { createZelavisClient } = await load(previous, 'sdk/fetch.js');
const baseUrl = 'http://127.0.0.1:3000';
const cookie = await readFile('/var/lib/zelavis/qualification-session', 'utf8');
const config = { baseUrl, headers: { cookie, origin: baseUrl }, fetch: (url, init) => fetch(url, {
  ...init, signal: AbortSignal.any([init?.signal, AbortSignal.timeout(90_000)].filter(Boolean)),
}) };
let client = createZelavisClient(config);
const id = 'update-continuity';
await client.projects.create({ id, name: 'Update continuity', start: false });
const frontend = `/var/lib/zelavis/projects/${id}/.zelavis/services/continuity`;
await mkdir(join(frontend, 'dist'), { recursive: true });
await writeFile(join(frontend, 'package.json'), JSON.stringify({ name: '@qualification/continuity', version: '1.0.0', zelavis: { kind: 'frontend', frontend: { runtime: 'static', bundle: 'dist' } } }));
await writeFile(join(frontend, 'dist/index.html'), '<h1>Stable site across real versions</h1>');
// This plugin resolves Zelavis from the engine actually executing it, so a
// descriptor rewrite cannot masquerade as a successful version switch.
const engineProof = `/var/lib/zelavis/projects/${id}/.zelavis/services/engine-proof`;
await mkdir(join(engineProof, 'dist'), { recursive: true });
await writeFile(join(engineProof, 'package.json'), JSON.stringify({ name: '@qualification/engine-proof', version: '1.0.0', type: 'module', exports: './dist/index.js',
  zelavis: { kind: 'plugin', namespace: 'engineproof' } }));
await writeFile(join(engineProof, 'dist/index.js'), `import { zelavis } from "zelavis/sdk";
import { ZELAVIS_VERSION } from "zelavis";
export function register() { zelavis.operations.create({ id: "engine.get", resource: "engine", action: "get", method: "GET", path: "/engine",
  spec: { operationId: "getExecutingEngine", summary: "Report the executing engine" }, handler: () => ({ status: 200, body: { version: ZELAVIS_VERSION } }) }); }`);
execFileSync('chown', ['-R', 'zelavis:zelavis', join(frontend, '..')]);
const app = await client.projects.start(id);
const data = () => client.data(id);
await data().collections.create({ name: 'continuity' });
await data().documents.insert('continuity', { id: 'stable', data: { value: 'retained across real engine versions' } });
const descriptor = async projectId => JSON.parse(await readFile(`/var/lib/zelavis/projects/${projectId}/project.json`, 'utf8'));
assert.equal((await descriptor(id)).engine.runtime.version, from);
const projectClient = projectId => createZelavisClient({ ...config, rootPath: `/zelavis/api/v1/runtime/projects/${projectId}/proxy/zelavis` });
const executingVersion = () => projectClient(id).plugins.engineproof.engine.get();
assert.equal((await executingVersion()).version, from, 'Initial running engine must report the previous npm version');
const wp = await client.projects.get('qualification-wordpress');
assert.equal(wp.recipe.version, '0.0.0-qualification', 'A historical integration fixture must already be serving');
const wpData = '/var/lib/zelavis/projects/qualification-wordpress/.zelavis';
await writeFile(join(wpData, 'wordpress/integration-preserved.txt'), 'Application content stays outside recipe updates.');
const wpFiles = ['wordpress-native.json', 'nginx.conf', 'php-fpm.conf', 'wordpress/wp-config.php', 'wordpress/wp-includes/version.php', 'wordpress/integration-preserved.txt'];
const fingerprints = async () => Object.fromEntries(await Promise.all(wpFiles.map(async file => {
  const path = join(wpData, file), metadata = await stat(path);
  return [file, { digest: createHash('sha256').update(await readFile(path)).digest('hex'),
    uid: metadata.uid, gid: metadata.gid, mode: metadata.mode, inode: metadata.ino, modified: metadata.mtimeMs }];
})));
const appFilesBefore = await fingerprints();
const identities = async () => (await Promise.all((await readdir('/var/lib/zelavis/projects/.agent-processes')).map(async file => {
  const value = JSON.parse(await readFile(join('/var/lib/zelavis/projects/.agent-processes', file), 'utf8'));
  return `${value.workloadId}:${value.pid}`;
}))).sort();
const wpClient = projectClient(wp.id);
const initialBound = await wpClient.runtime.config();
assert.equal(initialBound.services.find(service => service.name === '@zelavis/wordpress').menus[0].title, 'Historical SDK integration');
assert.equal((await wpClient.plugins.wordpress.integration.get()).revision, 'historical');
const wpControl = `${baseUrl}/zelavis/api/v1/runtime/projects/${wp.id}/proxy/zelavis/api/v1/runtime/config`;
const before = await identities();
const hostPid = () => execFileSync('systemctl', ['show', 'zelavis.service', '-p', 'MainPID', '--value'], { encoding: 'utf8' }).trim();
const initialPid = hostPid();
// A changed installed template must be replaced by the selected release,
// without stopping the service currently using it.
const unitFile = '/etc/systemd/system/zelavis.service';
await writeFile(unitFile, `# Qualification marker: refresh during live root commit\n${await readFile(unitFile, 'utf8')}`);
const urls = [`${baseUrl}/zelavis/`, `http://127.0.0.1:${app.preview.port}/`, `http://127.0.0.1:${wp.preview.port}/wp-admin/`, `http://127.0.0.1:${wp.preview.port}/integration-preserved.txt`];
urls.push(`${baseUrl}/zelavis/api/v1/runtime/projects/${id}/proxy/zelavis/api/v1/plugins/engineproof/engine`, wpControl);
const counts = Object.fromEntries(urls.map(url => [url, 0]));
async function underTraffic(operation) {
  let finished = false;
  const traffic = Promise.all(urls.map(async url => {
    do {
      const response = await fetch(url, { ...(url.startsWith(`${baseUrl}/zelavis/api/`) ? { headers: { cookie } } : {}), redirect: 'manual', signal: AbortSignal.timeout(30_000) });
      assert.ok([200, 302].includes(response.status), `${url}: ${response.status}`);
      await response.arrayBuffer(); counts[url]++;
      await new Promise(resolve => setTimeout(resolve, 20));
    } while (!finished);
  }));
  const action = operation().finally(() => { finished = true; });
  const outcomes = await Promise.allSettled([action, traffic]);
  for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
  return outcomes[0].value;
}
const execute = promisify(execFile);
async function run(command, args) {
  try { const result = await execute(command, args, { maxBuffer: 16 * 1024 * 1024, timeout: 300_000 }); return { code: 0, output: result.stdout + result.stderr }; }
  catch (error) { return { code: typeof error.code === 'number' ? error.code : 1, output: String(error.stdout ?? '') + String(error.stderr ?? '') + error.message }; }
}
await underTraffic(async () => {
  if (mode === 'npm') {
    const checked = await client.updates.check();
    assert.equal(checked.latest, to, 'Published alpha tag must select this release');
    assert.equal(checked.available, true);
    await client.updates.apply(); // The dashboard's ordinary authenticated action; no test transport.
    for (let attempt = 0; attempt < 600; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 500));
      const state = await client.updates.status();
      if (['failed', 'rolled-back'].includes(state.run?.state)) throw Error(JSON.stringify(state));
      if (state.run?.state === 'succeeded' && state.current === to) return;
    }
    throw Error('Update action did not complete');
  }
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
});
assert.equal(hostPid(), initialPid, 'Platform host must remain the same process');
assert.deepEqual(await identities(), before, 'Project supervision must survive the update');
assert.equal(JSON.parse(await readFile('/opt/zelavis/installation.json', 'utf8')).version, to);
assert.ok(!(await readFile(unitFile, 'utf8')).includes('Qualification marker'), 'Live root commit must refresh installed unit templates');
assert.equal((await descriptor(id)).engine.runtime.version, from, 'Parent update preserves App engine');
assert.equal((await executingVersion()).version, from, 'Parent update must retain the executing child engine');
assert.equal((await client.projects.get(id)).preview.port, app.preview.port);
({ createZelavisClient } = await load(await realpath('/opt/zelavis/current'), 'sdk/fetch.js'));
client = createZelavisClient(config);
assert.equal((await client.projects.get(wp.id)).recipe.version, wp.recipe.version, 'Parent update must preserve the managed recipe lock');
const beforeIntegration = await wpClient.runtime.config();
assert.equal(beforeIntegration.services.find(service => service.name === '@zelavis/wordpress').menus[0].title, 'Historical SDK integration');
assert.equal((await wpClient.plugins.wordpress.integration.get()).revision, 'historical');
for (const capability of ['database', 'identity', 'storage', 'workloads']) {
  assert.equal(beforeIntegration.capabilities[capability].available, true, `An adopted bound App must execute the current engine's ${capability} API`);
  assert.equal(beforeIntegration.capabilities[capability].used, false, 'Unused APIs stay hidden after engine convergence');
}
assert.equal(beforeIntegration.capabilities.fabric.available, false);
assert.equal((await client.projects.list()).projects.some(project => project.id.includes('integration')), false, 'The bound runtime has no separate Project card');
const integrationBefore = await identities();

const integration = await underTraffic(() => client.projects.upgrade(wp.id));
assert.equal(integration.runtime.status, 'running');
assert.equal(integration.preview.port, wp.preview.port);
assert.equal(integration.recipe.managed.adminTitle, 'WordPress Admin');
assert.equal(integration.capabilities.recipeUpdateMode, 'integration');
assert.equal(integration.runtimeUpdate, undefined);
assert.deepEqual(await identities(), integrationBefore, 'Integration update must retain app and integration host process identities');
assert.equal((await wpClient.runtime.config()).services.find(service => service.name === '@zelavis/wordpress').menus?.length ?? 0, 0, 'Removed SDK menus disappear immediately');
await assert.rejects(wpClient.plugins.wordpress.integration.get(), /not found|unknown|not available|operation/i);
assert.deepEqual(await fingerprints(), appFilesBefore, 'Recipe update must preserve app software, content, configuration and ownership');
console.log('PASS: running WordPress integration recipe update preserves processes, software, configuration, content and preview.');
const choices = await client.projects.versions(id);
assert.equal(choices.current, from);
assert.ok(choices.versions.some(entry => entry.version === from && entry.status === 'available'));
assert.ok(choices.versions.some(entry => entry.version === to && entry.status === 'available'));
for (const version of [to, from]) {
  const switched = await underTraffic(() => client.projects.switchVersion(id, version));
  assert.equal(switched.runtime.status, 'running');
  assert.equal(switched.preview.port, app.preview.port);
  const selected = await descriptor(id);
  assert.equal(selected.engine.runtime.version, version);
  assert.equal((await executingVersion()).version, version, 'Plugin code inside the executing engine must report the selected real npm version');
  const engineRoot = `/opt/zelavis/releases/${version}`;
  const recipe = JSON.parse(await readFile(join(engineRoot, 'platform/services/zelavis-app/package.json'), 'utf8'));
  assert.equal(switched.recipe.version, recipe.version);
  assert.deepEqual((await data().documents.get('continuity', 'stable')).data, { value: 'retained across real engine versions' });
  console.log(`PASS: live App selection ${version} with matching recipe, same preview and retained database record.`);
}
for (const version of ['latest', '^2.0.0', '99.0.0']) await assert.rejects(client.projects.switchVersion(id, version), { status: 400 });
const historical = await client.projects.create({ id: 'explicit-historical', name: 'Historical', engineVersion: from, start: false });
assert.equal(historical.engineVersion, from); assert.equal((await descriptor(historical.id)).engine.runtime.version, from);
for (const version of [to, from]) {
  const changed = await client.projects.switchVersion(historical.id, version);
  assert.equal(changed.runtime.status, 'stopped');
  assert.equal((await descriptor(historical.id)).engine.runtime.version, version);
}
assert.equal((await client.projects.start(historical.id)).runtime.status, 'running');
const latest = await client.projects.create({ id: 'explicit-latest', name: 'Latest', start: false });
assert.equal(latest.engineVersion, to); assert.equal((await descriptor(latest.id)).engine.runtime.version, to);
await client.projects.remove(historical.id); await client.projects.remove(latest.id); await client.projects.remove(id);
const proof = { from, to, acquisition: mode === 'npm' ? 'ordinary authenticated npm update action' : 'local candidate transport; published previous updater',
  platformHostPreserved: true, projectProcessesPreserved: true, parentPreservesAppPin: true,
  installedTemplatesRefreshed: true,
  managedRecipe: { from: wp.recipe.version, to: integration.recipe.version, historicalFixture: true,
    processesPreserved: true, appFilesAndConfigurationPreserved: true, previewPreserved: true, sdkMenuAndOperationRemovalProved: true, integrationGatewayContinuous: true },
  liveSelection: [to, from], executingEngineVersionsProved: true, dataRetained: true, requests: counts,
  artifact: JSON.parse(await readFile(`/opt/zelavis/releases/${to}/runtime-artifact.json`, 'utf8')).digest };
await writeFile('/tmp/zelavis-update-proof.json', JSON.stringify(proof, null, 2));
console.log(`PASS: published ${from} updates to ${to}; no stopped Projects or refused HTTP requests (${mode}).`);
