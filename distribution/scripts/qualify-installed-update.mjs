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
import { installRecipeIfAvailable } from './lib/install-recipe.mjs';
import { updateToLocalCandidate } from './lib/candidate-update.mjs';
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
// A genuine npm catalogue Project stays untouched by the historical fixture.
// This is the path behind Open that development-only manifests failed to test.
await installRecipeIfAvailable({ baseUrl, cookie }, '@zelavis/wordpress');
const catalogueApp = await client.projects.create({ id: 'catalogue-wordpress', name: 'Catalogue WordPress', recipeName: '@zelavis/wordpress', installHostPackages: true });
const catalogueDescriptor = await readFile('/var/lib/zelavis/projects/catalogue-wordpress/project.json', 'utf8');
const catalogueControl = `${baseUrl}/zelavis/api/v1/runtime/projects/${catalogueApp.id}/proxy/zelavis/api/v1/runtime/config`;
const initialCatalogueResponse = await fetch(catalogueControl, { headers: { cookie }, redirect: 'manual' });
const catalogueBeforeStatus = initialCatalogueResponse.status;
await initialCatalogueResponse.arrayBuffer();
const wp = await client.projects.get('qualification-wordpress');
assert.equal(wp.recipe.version, '0.0.0-qualification', 'A historical integration fixture must already be serving');
// Where WordPress lives: its software, configuration and content are never touched by a recipe update.
const wpProject = '/var/lib/zelavis/projects/qualification-wordpress';
const wpData = join(wpProject, 'app');
/**
 * The layout contract of the recipe the Project runs: 0 for the hand-written runtime of releases before
 * alpha.26 (no install manifest), 1 keeps the server's files in app/, 2 in .zelavis/server.
 */
const wpContract = async () => JSON.parse(await readFile(join(wpProject, '.zelavis/recipe/package/package.json'), 'utf8')).zelavis.project.install?.contract ?? 0;
// The hand-written runtime kept the site in .zelavis/wordpress; taking it over renames it into app/site, so
// the same files keep their inode and modification time across the move.
const wpSite = async () => (await wpContract()) === 0 ? join(wpProject, '.zelavis/wordpress') : join(wpData, 'site');
await writeFile(join(await wpSite(), 'integration-preserved.txt'), 'Application content stays outside recipe updates.');
const wpFiles = ['wp-config.php', 'wp-includes/version.php', 'integration-preserved.txt'];
const fingerprints = async () => { const site = await wpSite(); return Object.fromEntries(await Promise.all(wpFiles.map(async file => {
  const path = join(site, file), metadata = await stat(path);
  return [file, { digest: createHash('sha256').update(await readFile(path)).digest('hex'),
    uid: metadata.uid, gid: metadata.gid, mode: metadata.mode, inode: metadata.ino, modified: metadata.mtimeMs }];
}))); };
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
async function underTraffic(operation, label = "live operation") {
  let finished = false; const started = Date.now();
  const traffic = Promise.all(urls.map(async url => {
    do {
      const response = await fetch(url, { ...(new URL(url).pathname.startsWith("/zelavis/api/") ? { headers: { cookie } } : {}), redirect: 'manual', signal: AbortSignal.timeout(30_000) })
        .catch(error => { throw Error(`${label}: ${url} failed after ${Date.now() - started}ms`, { cause: error }); });
      assert.ok([200, 302].includes(response.status), `${url}: ${response.status}`);
      await response.arrayBuffer(); counts[url]++;
      await new Promise(resolve => setTimeout(resolve, 20));
    } while (!finished);
  }));
  const action = operation().finally(() => { finished = true; console.log(`TRAFFIC: ${label} completed in ${Date.now() - started}ms`); });
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
  await updateToLocalCandidate({ previous, to, baseUrl });
});
assert.equal(hostPid(), initialPid, 'Platform host must remain the same process');
assert.deepEqual(await identities(), before, 'Project supervision must survive the update');
assert.equal(JSON.parse(await readFile('/opt/zelavis/installation.json', 'utf8')).version, to);
assert.ok(!(await readFile(unitFile, 'utf8')).includes('Qualification marker'), 'Live root commit must refresh installed unit templates');
assert.equal((await descriptor(id)).engine.runtime.version, from, 'Parent update preserves App engine');
assert.equal((await executingVersion()).version, from, 'Parent update must retain the executing child engine');
assert.equal((await client.projects.get(id)).preview.port, app.preview.port);
// The ordinary update must activate production ingress even without a domain.
const ingressUrl = 'http://127.0.0.1/zelavis/';
for (let attempt = 0; attempt < 60; attempt++) {
  const response = await fetch(ingressUrl, { signal: AbortSignal.timeout(5_000) });
  if (response.status === 200) break;
  assert.ok(attempt < 59, `Production ingress did not converge: ${response.status}`);
  await new Promise(resolve => setTimeout(resolve, 500));
}
assert.equal(execFileSync('systemctl', ['is-active', 'zelavis-traefik.service'], { encoding: 'utf8' }).trim(), 'active');
assert.equal(execFileSync('systemctl', ['is-enabled', 'zelavis-traefik.service'], { encoding: 'utf8' }).trim(), 'enabled');
const proxyPid = () => execFileSync('systemctl', ['show', 'zelavis-traefik.service', '-p', 'MainPID', '--value'], { encoding: 'utf8' }).trim();
const initialProxyPid = proxyPid();
assert.notEqual(initialProxyPid, '0');
const html = await (await fetch(ingressUrl)).text();
const asset = html.match(/(?:src|href)="([^" ]+\.js(?:\?[^" ]*)?)"/);
assert.ok(asset, 'The public dashboard must include a browser entry asset');
const assetResponse = await fetch(new URL(asset[1], ingressUrl));
assert.equal(assetResponse.status, 200);
assert.match(assetResponse.headers.get('content-type') ?? '', /javascript/);
await assetResponse.arrayBuffer();
for (const publicUrl of [ingressUrl, 'http://127.0.0.1/zelavis/api/v1/runtime/config',
  `http://127.0.0.1/zelavis/api/v1/runtime/projects/${id}/proxy/zelavis/api/v1/plugins/engineproof/engine`]) {
  urls.push(publicUrl); counts[publicUrl] = 0;
}
const candidateRoot = `/opt/zelavis/releases/${to}`;
for (const version of [from, to]) {
  await underTraffic(async () => {
    const selection = await run(join(candidateRoot, 'runtime/node/bin/node'), [join(candidateRoot, 'platform/dist/adapters/_node-runtime-select-cli.js'), '/opt/zelavis', 'default', '/var/lib/zelavis', version]);
    assert.equal(selection.code, 0, selection.output);
  });
  assert.equal(JSON.parse(await readFile('/opt/zelavis/runtime.json', 'utf8')).version, version);
  assert.equal(hostPid(), initialPid);
  assert.equal(proxyPid(), initialProxyPid, 'Traefik must stay running through full Platform engine changes');
}
console.log('PASS: domain-free production ingress and assets; Platform rollback/reselection preserve proxy and traffic.');

({ createZelavisClient } = await load(await realpath('/opt/zelavis/current'), 'sdk/fetch.js'));
client = createZelavisClient(config);
assert.equal((await client.projects.get(wp.id)).recipe.version, wp.recipe.version, 'Parent update must preserve the managed recipe lock');
const catalogueAfter = await client.projects.get(catalogueApp.id);
assert.equal(catalogueAfter.recipe.managed.adminTitle, 'WordPress Admin');
assert.equal(catalogueAfter.recipe.version, catalogueApp.recipe.version);
assert.equal(catalogueAfter.runtime.url, catalogueApp.runtime.url);
assert.equal(catalogueAfter.preview.port, catalogueApp.preview.port);
assert.equal(await readFile('/var/lib/zelavis/projects/catalogue-wordpress/project.json', 'utf8'), catalogueDescriptor, 'Fixing Open never rewrites the frozen host descriptor');
const catalogueConfig = await projectClient(catalogueApp.id).runtime.config();
assert.equal(catalogueConfig.services.find(service => service.name === '@zelavis/wordpress').kind, 'app');
for (const capability of ['database', 'identity', 'storage', 'workloads']) assert.equal(catalogueConfig.capabilities[capability].used, false);
urls.push(catalogueControl);
counts[catalogueControl] = 0;
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
const contractBefore = await wpContract();

const integration = await underTraffic(() => client.projects.upgrade(wp.id));
assert.equal(integration.runtime.status, 'running');
assert.equal(integration.preview.port, wp.preview.port);
assert.equal(integration.recipe.managed.adminTitle, 'WordPress Admin');
assert.equal(integration.capabilities.recipeUpdateMode, 'integration');
assert.equal(integration.runtimeUpdate, undefined);
const contractAfter = await wpContract();
if (contractAfter === contractBefore) {
  assert.deepEqual(await identities(), integrationBefore, 'Integration update must retain app and integration host process identities');
} else {
  // Moving to the layout where app/ is the application alone changes where the servers read their configuration,
  // so their processes are replaced while requests wait (the traffic above proves none failed).
  assert.equal(contractAfter, 2);
  assert.deepEqual((await readdir(wpData)).sort(), ['db', 'site'], 'app/ holds WordPress and its database alone');
  await stat(join(wpProject, '.zelavis/server/Caddyfile'));
  console.log(`PASS: WordPress moved from recipe contract ${contractBefore} to 2 under traffic; app/ holds the application alone.`);
}
assert.equal((await wpClient.runtime.config()).services.find(service => service.name === '@zelavis/wordpress').menus?.length ?? 0, 0, 'Removed SDK menus disappear immediately');
await assert.rejects(wpClient.plugins.wordpress.integration.get(), /not found|unknown|not available|operation/i);
assert.deepEqual(await fingerprints(), appFilesBefore, 'Recipe update must preserve app software, content, configuration and ownership');
console.log('PASS: running WordPress integration recipe update preserves processes, software, configuration, content and preview.');
const choices = await client.projects.versions(id);
assert.equal(choices.current, from);
assert.ok(choices.versions.some(entry => entry.version === from && entry.status === 'available'));
assert.ok(choices.versions.some(entry => entry.version === to && entry.status === 'available'));
for (const version of [to, from]) {
  const switched = await underTraffic(() => client.projects.switchVersion(id, version), `App selection ${version}`);
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
const freshManaged = await client.projects.create({ id: 'fresh-catalogue-wordpress', name: 'Fresh catalogue WordPress', recipeName: '@zelavis/wordpress', installHostPackages: true });
assert.equal(freshManaged.recipe.managed.adminTitle, 'WordPress Admin');
assert.equal((await projectClient(freshManaged.id).runtime.config()).capabilities.database.used, false);
await client.projects.remove(freshManaged.id);
// A recipe the Marketplace only lists is acquired from npm; the Project created from it is locked with the
// package's install methods, starts and serves. A second Project of the same recipe, created after the first
// is deleted, must still run: they share one recipe driver, which must not run from the deleted Project's files.
await installRecipeIfAvailable({ baseUrl, cookie }, '@zelavis/dokuwiki');
for (const wikiId of ['installed-catalogue-dokuwiki', 'recreated-catalogue-dokuwiki']) {
  const wiki = await client.projects.create({ id: wikiId, name: 'Installed catalogue DokuWiki', recipeName: '@zelavis/dokuwiki' });
  assert.equal(wiki.recipe.install?.method, 'native', 'A Project from an installed catalogue recipe is locked with its install methods');
  assert.equal(wiki.runtime.status, 'running', `${wikiId} starts: ${JSON.stringify(wiki.runtime)}`);
  const page = await fetch(`http://127.0.0.1:${wiki.preview.port}/doku.php`);
  assert.equal(page.status, 200, `${wikiId} serves DokuWiki through its preview`);
  await page.arrayBuffer();
  await client.projects.remove(wikiId);
}
console.log('PASS: a catalogue recipe installed from npm runs, and runs again for a Project created after the first was deleted.');
await client.projects.remove(catalogueApp.id);
await client.projects.remove(historical.id); await client.projects.remove(latest.id); await client.projects.remove(id);
const proof = { from, to, acquisition: mode === 'npm' ? 'ordinary authenticated npm update action' : 'local candidate transport; published previous updater',
  platformHostPreserved: true, projectProcessesPreserved: true, parentPreservesAppPin: true,
  installedTemplatesRefreshed: true,
  productionIngress: { domainRequired: false, dashboardAndAssetsProved: true, enabled: true, proxyProcessPreserved: true, platformSelections: [from, to], continuousHTTP: true },
  managedOpen: { previousStatus: catalogueBeforeStatus, configAfterUpdate: 200, descriptorUnchanged: true, recipeVersionUnchanged: true, unusedAPIsHidden: true, freshNpmCatalogueProjectProved: true, installedCatalogueRecipeLocksInstall: true },
  managedRecipe: { from: wp.recipe.version, to: integration.recipe.version, historicalFixture: true,
    processesPreserved: true, appFilesAndConfigurationPreserved: true, previewPreserved: true, sdkMenuAndOperationRemovalProved: true, integrationGatewayContinuous: true },
  liveSelection: [to, from], executingEngineVersionsProved: true, dataRetained: true, requests: counts,
  artifact: JSON.parse(await readFile(`/opt/zelavis/releases/${to}/runtime-artifact.json`, 'utf8')).digest };
await writeFile('/tmp/zelavis-update-proof.json', JSON.stringify(proof, null, 2));
console.log(`PASS: published ${from} updates to ${to}; no stopped Projects or refused HTTP requests (${mode}).`);
