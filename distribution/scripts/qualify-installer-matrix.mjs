// Runs only inside a disposable systemd guest. The wrapper supplies verified
// private Node, the authored bootstrap, a packed create entry and packaging code.
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, cp, lstat, mkdir, readFile, readdir, readlink, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

assert.equal(process.env.ZELAVIS_QUALIFY_DISPOSABLE, '1');
assert.equal(process.platform, 'linux');
assert.equal(process.getuid(), 0);
assert.equal((await readFile('/proc/1/comm', 'utf8')).trim(), 'systemd');
const configuration = JSON.parse(await readFile('/input/qualification.json', 'utf8'));
const phase = configuration.phase ?? 'all';
assert.ok(['all', 'entries', 'instances', 'deb'].includes(phase));
assert.equal(process.arch, configuration.architecture, 'Qualification must execute the requested architecture');
for (const version of [configuration.target, configuration.baseline]) assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
assert.notEqual(configuration.target, configuration.baseline);
const root = '/qualification';
const target = join(root, 'current');
const baseline = join(root, 'baseline');
const logs = join(root, 'logs');
await mkdir(logs, { recursive: true, mode: 0o700 });
process.env.PATH = `${dirname(process.execPath)}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
const execute = promisify(execFile);
const scrub = source => String(source).split('\n').map(line => /token|password|secret|authorization|cookie/i.test(line) ? '[redacted]' : line).join('\n');
const report = { architecture: process.arch, kernel: execFileSync('uname', ['-r'], { encoding: 'utf8' }).trim(), os: await readFile('/etc/os-release', 'utf8'), target: configuration.target, baseline: configuration.baseline, checks: [], transitions: [] };
report.phase = phase;
report.nodeOptions = process.env.NODE_OPTIONS ?? null;
let sequence = 0;
async function command(executable, args, label, timeout = 300_000) {
  const logfile = join(logs, `${++sequence}-${label}.log`);
  try {
    const result = await execute(executable, args, { timeout, maxBuffer: 8 * 1024 * 1024 });
    await writeFile(logfile, result.stdout + result.stderr, { mode: 0o600 });
    return result.stdout;
  } catch (error) {
    await writeFile(logfile, String(error.stdout ?? '') + String(error.stderr ?? ''), { mode: 0o600 });
    throw new Error(`${label} failed (${error.code ?? error.message}): ${scrub(String(error.stdout ?? '') + String(error.stderr ?? '')).split('\n').slice(-50).join('\n')}`, { cause: error });
  }
}
async function passed(description) {
  report.checks.push(description);
  await writeFile(join(root, 'proof.json'), JSON.stringify(report, null, 2));
  console.log(`PASS: ${description}`);
}
async function until(description, operation, milliseconds = 120_000) {
  const deadline = Date.now() + milliseconds;
  let last;
  do {
    try { return await operation(); } catch (error) { if (error.terminal || error instanceof TypeError && !error.cause) throw error; last = error; }
    await new Promise(resolve => setTimeout(resolve, 500));
  } while (Date.now() < deadline);
  throw new Error(`${description}: ${last?.message ?? 'deadline expired'}`, { cause: last });
}
const suffix = instance => instance === 'default' ? '' : `-${instance}`;
const inventory = instance => instance === 'default' ? '/opt/zelavis' : `/opt/zelavis/instances/${instance}`;
const dataDirectory = instance => `/var/lib/zelavis${suffix(instance)}`;
const configDirectory = instance => `/etc/zelavis${suffix(instance)}`;
const port = instance => instance === 'default' ? 3000 : 3100;
const unit = instance => instance === 'default' ? 'zelavis.service' : `zelavis@${instance}.service`;
const baseUrl = instance => `http://127.0.0.1:${port(instance)}`;
const json = async path => JSON.parse(await readFile(path, 'utf8'));
async function bootstrap(instance) {
  const response = await fetch(`${baseUrl(instance)}/zelavis/api/v1/auth/bootstrap`, { signal: AbortSignal.timeout(5_000) });
  assert.equal(response.status, 200);
  return response.json();
}
const ready = instance => until(`${instance} readiness`, () => bootstrap(instance));
const loadClient = async () => (await import(pathToFileURL(join(target, 'platform/dist/sdk/fetch.js')).href)).createZelavisClient;
const sessions = new Map();
async function client(instance) {
  const create = await loadClient();
  return create({ baseUrl: baseUrl(instance), headers: { cookie: sessions.get(instance), origin: baseUrl(instance) }, fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.any([init?.signal, AbortSignal.timeout(120_000)].filter(Boolean)) }) });
}
async function claim(instance) {
  assert.equal((await ready(instance)).required, true);
  const environment = await readFile(`${configDirectory(instance)}/zelavis.env`, 'utf8');
  const bootstrapToken = /^ZELAVIS_BOOTSTRAP_TOKEN=(.+)$/m.exec(environment)?.[1];
  assert.ok(bootstrapToken);
  const response = await fetch(`${baseUrl(instance)}/zelavis/api/v1/auth/bootstrap`, { method: 'POST', signal: AbortSignal.timeout(120_000), headers: { 'content-type': 'application/json', origin: baseUrl(instance) }, body: JSON.stringify({ bootstrapToken, provider: 'password', account: { email: 'matrix@example.test' }, credential: { identifier: 'matrix@example.test', password: 'disposable installer qualification password 2026' } }) });
  assert.equal(response.status, 201);
  sessions.set(instance, response.headers.get('set-cookie').split(';')[0]);
  assert.equal((await bootstrap(instance)).required, false);
}
async function configureProxy(instance) {
  if (!process.env.HTTPS_PROXY) return;
  const file = `${configDirectory(instance)}/zelavis.env`;
  const content = await readFile(file, 'utf8');
  if (!/^HTTPS_PROXY=/m.test(content)) {
    await writeFile(file, content + `\nHTTPS_PROXY=${process.env.HTTPS_PROXY}\nHTTP_PROXY=${process.env.HTTP_PROXY}\nNO_PROXY=127.0.0.1,localhost,::1\nNODE_USE_ENV_PROXY=1\n`);
    const updater = instance === 'default' ? 'zelavis-update.service' : `zelavis-update-${instance}.service`;
    await mkdir(`/etc/systemd/system/${updater}.d`, { recursive: true });
    await writeFile(`/etc/systemd/system/${updater}.d/qualification-proxy.conf`, `[Service]\nEnvironment=HTTPS_PROXY=${process.env.HTTPS_PROXY}\nEnvironment=HTTP_PROXY=${process.env.HTTP_PROXY}\nEnvironment=NO_PROXY=127.0.0.1,localhost,::1\nEnvironment=NODE_USE_ENV_PROXY=1\n`);
    await command('systemctl', ['daemon-reload'], 'proxy-updater');
    await command('systemctl', ['restart', unit(instance)], 'proxy-environment');
  }
}
async function doctor(instance) {
  await until(`${instance} doctor`, async () => {
    const output = await command(`/opt/zelavis/current/runtime/node/bin/node`, ['/opt/zelavis/current/platform/dist/cli.js', 'doctor', '--instance', instance, '--json'], `doctor-${instance}`, 20_000);
    const value = JSON.parse(output);
    assert.equal(value.healthy, true, JSON.stringify(value.checks.filter(check => check.status !== 'ok')));
  });
}
async function snapshot(instance) {
  const pid = Number((await command('systemctl', ['show', unit(instance), '-p', 'MainPID', '--value'], 'pid', 10_000)).trim());
  const owner = await json(`${dataDirectory(instance)}/.platform-owner.json`);
  const tick = async id => (await readFile(`/proc/${id}/stat`, 'utf8')).split(') ')[1].split(' ')[19];
  return { pid, tick: await tick(pid), ownerPid: owner.pid, ownerTick: await tick(owner.pid), environment: createHash('sha256').update(await readFile(`${configDirectory(instance)}/zelavis.env`)).digest('hex'), version: (await json(`${inventory(instance)}/installation.json`)).version };
}
async function projectProcesses(instance) {
  const directory = `${dataDirectory(instance)}/projects/.agent-processes`;
  const pids = [];
  for (const name of (await readdir(directory)).filter(name => name.endsWith('.json'))) {
    const record = await json(join(directory, name));
    if (record.workloadId === 'matrix-app' && Number.isInteger(record.pid)) pids.push(record.pid);
  }
  assert.ok(pids.length, 'The running Project must have an Agent process record');
  const result = [];
  const seen = new Set();
  while (pids.length) {
    const pid = pids.pop(); if (seen.has(pid)) continue; seen.add(pid);
    assert.ok(seen.size <= 64, 'Bounded native Project process tree');
    const fields = (await readFile(`/proc/${pid}/stat`, 'utf8')).split(') ')[1].split(' ');
    result.push({ pid, tick: fields[19] });
    const children = (await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8')).trim();
    if (children) pids.push(...children.split(/\s+/).map(Number));
  }
  return result.sort((a, b) => a.pid - b.pid);
}
async function seedProject(instance) {
  const api = await client(instance);
  await api.projects.create({ id: 'matrix-app', name: 'Installer continuity', start: false });
  await api.projects.start('matrix-app');
  await api.data('matrix-app').collections.create({ name: 'continuity' });
  await api.data('matrix-app').documents.insert('continuity', { id: 'sentinel', data: { instance, value: 'retained across installer entries and live updates' } });
  return json(`${dataDirectory(instance)}/projects/matrix-app/project.json`);
}
async function checkProject(instance, initial) {
  await until(`${instance} Project data`, async () => {
    const api = await client(instance);
    const document = await api.data('matrix-app').documents.get('continuity', 'sentinel');
    assert.equal(document.data.instance, instance);
    assert.equal(document.data.value, 'retained across installer entries and live updates');
  });
  const actual = await json(`${dataDirectory(instance)}/projects/matrix-app/project.json`);
  assert.deepEqual(actual.recipe, initial.recipe, 'An installer must not rewrite a Project recipe lock');
  assert.deepEqual(actual.engine.runtime, initial.engine.runtime, 'An installer must not change an App engine selection');
}
async function receipt(instance, version) {
  await ready(instance);
  const value = await json(`${inventory(instance)}/installation.json`);
  const runtime = await json(`${inventory(instance)}/runtime.json`);
  assert.equal(value.version, version); assert.equal(runtime.version, version);
  assert.equal(await realpath(`${inventory(instance)}/current`), `/opt/zelavis/releases/${version}`);
  assert.equal(value.instance, instance); assert.equal(value.port, port(instance)); assert.equal(value.edge, instance === 'default');
  assert.equal(value.dataDirectory, dataDirectory(instance)); assert.equal(value.configDirectory, configDirectory(instance));
  assert.equal(value.mode, 'system'); assert.equal(value.ownsUser, true); assert.equal(value.ownsGroup, true);
  const uid = Number((await command('id', ['-u', `zelavis${suffix(instance)}`], 'uid')).trim());
  assert.equal((await stat(dataDirectory(instance))).uid, uid);
  assert.equal((await stat(`${configDirectory(instance)}/zelavis.env`)).mode & 0o777, 0o600);
  return value;
}
async function entry(kind) {
  if (kind === 'script') await command('/bin/sh', ['/input/install.sh', '--version', configuration.target], 'install-script');
  else if (kind === 'create') {
    await command(process.execPath, [join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'), 'exec', '--cache', `${root}/npm-cache`, '--yes', '--package', '/input/create-zelavis.tgz', '--', 'create-zelavis', '--system', '--yes'], 'install-create');
  } else await command('dpkg', ['--force-confdef', '--force-confold', '--install', report.deb], 'install-deb');
  await ready('default'); await configureProxy('default'); await receipt('default', configuration.target); await doctor('default');
}
async function installRelease(source, instance) {
  await command(`${source}/runtime/node/bin/node`, [`${source}/platform/dist/cli.js`, 'install', '--from-release', source, '--instance', instance, '--port', String(port(instance))], `release-${instance}`);
  await ready(instance); await configureProxy(instance);
  await ready(instance);
}
async function remove(instance) {
  await command('/opt/zelavis/current/runtime/node/bin/node', ['/opt/zelavis/current/platform/dist/cli.js', 'uninstall', '--instance', instance, '--all', '--confirm', 'DELETE-ALL-ZELAVIS-DATA'], `uninstall-${instance}`);
  for (const path of [dataDirectory(instance), configDirectory(instance)]) await assert.rejects(access(path), { code: 'ENOENT' });
  await assert.rejects(execute('getent', ['passwd', `zelavis${suffix(instance)}`]));
  await assert.rejects(execute('getent', ['group', `zelavis${suffix(instance)}`]));
}
async function removedAll() {
  for (const path of ['/opt/zelavis', '/usr/local/bin/zelavis', '/usr/bin/zelavis', '/etc/systemd/system/zelavis.service', '/etc/systemd/system/zelavis@.service']) await assert.rejects(lstat(path), { code: 'ENOENT' });
  const found = [];
  for (const pid of (await readdir('/proc')).filter(name => /^\d+$/.test(name))) {
    try { if ((await readlink(`/proc/${pid}/exe`)).startsWith('/opt/zelavis/')) found.push(pid); } catch (error) { if (!['ENOENT', 'ESRCH', 'EACCES'].includes(error.code)) throw error; }
  }
  assert.deepEqual(found, [], 'Installed processes must not survive complete removal');
}
async function prepare() {
  for (const [version, destination] of [[configuration.target, target], [configuration.baseline, baseline]]) {
    if (phase === 'deb' && destination === baseline) continue;
    if (process.env.ZELAVIS_QUALIFY_REUSE_INPUTS === '1') {
      assert.equal((await json(`${destination}/manifest.json`)).version, version);
      assert.equal((await json(`${destination}/runtime-artifact.json`)).version, version);
      await access(`${destination}/runtime/node/bin/node`);
      await access(`${destination}/platform/dist/cli.js`);
    } else {
      await command('/bin/sh', ['/input/install.sh', '--version', version, '--stage-only'], `acquire-${version}`);
      await rm(destination, { recursive: true, force: true });
      await cp(`/opt/zelavis/releases/${version}`, destination, { recursive: true, verbatimSymlinks: true });
    }
  }
  await assert.rejects(access('/opt/zelavis/installation.json'), { code: 'ENOENT' });
  await assert.rejects(execute('getent', ['passwd', 'zelavis']));
  await rm('/opt/zelavis', { recursive: true, force: true });
  if (phase === 'instances') {
    await passed('Exact published releases verified for the instance lifecycle qualification');
    return;
  }
  const packaging = `${root}/distribution/scripts`;
  await mkdir(packaging, { recursive: true });
  await cp('/input/build-deb.mjs', `${packaging}/build-deb.mjs`);
  const artifacts = `${root}/distribution/artifacts`;
  if (configuration.debSha256) {
    // A package built by this script in another guest of the same architecture
    // can qualify both distributions without recompressing identical bytes.
    assert.match(configuration.debSha256, /^[0-9a-f]{64}$/);
    assert.equal(createHash('sha256').update(await readFile('/input/zelavis.deb')).digest('hex'), configuration.debSha256);
    await mkdir(artifacts, { recursive: true });
    await cp('/input/zelavis.deb', join(artifacts, 'zelavis.deb'));
  } else {
    await command(process.execPath, [`${packaging}/build-deb.mjs`, '--stage', target], 'build-deb', 900_000);
  }
  const packages = (await readdir(artifacts)).filter(name => name.endsWith('.deb'));
  assert.equal(packages.length, 1);
  report.deb = join(artifacts, packages[0]);
  report.debSha256 = createHash('sha256').update(await readFile(report.deb)).digest('hex');
  report.packagingSourceSha256 = createHash('sha256').update(await readFile('/input/build-deb.mjs')).digest('hex');
  assert.equal((await command('dpkg-deb', ['--field', report.deb, 'Version'], 'deb-version')).trim(), configuration.target.replace(/-([0-9A-Za-z])/g, '~$1'));
  assert.equal((await command('dpkg-deb', ['--field', report.deb, 'Architecture'], 'deb-architecture')).trim(), { arm64: 'arm64', x64: 'amd64' }[configuration.architecture]);
  await passed(`Exact published releases acquired; local Debian package ${configuration.debSha256 ? 'verified from the preceding guest' : 'built by the authored packaging script'}`);
}
async function matrix() {
  const cases = phase === 'deb' ? [['deb', []]] : [
    ['script', ['script', 'create', 'create', 'deb', 'deb', 'script', 'deb', 'create', 'script']],
    ['create', []], ['deb', []],
  ];
  for (const [first, next] of cases) {
    sessions.clear(); await entry(first); await claim('default');
    const project = await seedProject('default');
    const environment = (await snapshot('default')).environment;
    await passed(`Fresh ${first} install: real systemd, owner claim, App creation and persisted data`);
    let previous = first;
    for (const kind of next) {
      await entry(kind);
      assert.equal((await bootstrap('default')).required, false);
      assert.equal((await snapshot('default')).environment, environment, 'Entry changes must preserve bootstrap/configuration');
      await checkProject('default', project);
      const actual = await json('/opt/zelavis/installation.json');
      assert.equal(actual.installedBy, { script: 'script', create: 'create', deb: 'deb' }[kind]);
      report.transitions.push(`${previous}->${kind}`);
      await passed(`${previous} -> ${kind}: receipt, owner/token, Project recipe/engine and data retained`);
      previous = kind;
    }
    if (first === 'deb') {
      await command('dpkg', ['--remove', 'zelavis'], 'dpkg-remove');
      await assert.rejects(execute('systemctl', ['is-active', '--quiet', 'zelavis.service']), 'Debian removal must stop the Platform');
      await assert.rejects(execute('systemctl', ['is-active', '--quiet', 'zelavis-traefik.service']), 'Debian removal must stop ingress');
      for (const unit of ['zelavis.socket', 'zelavis-update.path', 'zelavis-update.service']) {
        await assert.rejects(execute('systemctl', ['is-active', '--quiet', unit]), 'Debian removal must stop activation and updates');
      }
      for (const unit of ['zelavis.socket', 'zelavis-update.path']) {
        await assert.rejects(execute('systemctl', ['is-enabled', '--quiet', unit]), 'Debian removal must disable activation');
      }
      await assert.rejects(fetch(`${baseUrl('default')}/zelavis/api/v1/auth/bootstrap`, { signal: AbortSignal.timeout(2_000) }), 'A management request must not reactivate the removed Platform');
      await entry('deb'); await checkProject('default', project);
      await passed('Debian remove/reinstall stops owned services and preserves application data');
    }
    await remove('default'); await removedAll(); await passed(`Complete removal after fresh ${first} entry clears owned files, accounts and processes`);
  }
  if (phase !== 'deb') assert.equal(new Set(report.transitions).size, 9, 'All nine ordered entry pairs must be exercised');
}
async function liveUpdate(instance) {
  const api = await client(instance);
  const available = await api.updates.check();
  assert.equal(available.latest, configuration.target); assert.equal(available.available, true);
  await api.updates.apply();
  await until(`${instance} live update`, async () => {
    const value = await api.updates.status();
    if (['failed', 'rolled-back'].includes(value.run?.state)) throw Object.assign(new Error(JSON.stringify(value)), { terminal: true });
    assert.equal(value.run?.state, 'succeeded'); assert.equal(value.current, configuration.target);
  }, 240_000);
  await receipt(instance, configuration.target); await doctor(instance);
  assert.equal((await json(`${dataDirectory(instance)}/agent/agent.json`)).release, configuration.target);
}
async function instances() {
  for (const [firstInstall, firstRemove] of [['default', 'default'], ['preview', 'preview']]) {
    sessions.clear();
    const other = firstInstall === 'default' ? 'preview' : 'default';
    await installRelease(baseline, firstInstall);
    if (firstInstall === 'preview') {
      await assert.rejects(access('/opt/zelavis/installation.json'), { code: 'ENOENT' });
      await assert.rejects(access('/opt/zelavis/edge-owner.json'), { code: 'ENOENT' });
    }
    await installRelease(baseline, other);
    await claim('default'); assert.equal((await bootstrap('preview')).required, true); await claim('preview');
    const projects = { default: await seedProject('default'), preview: await seedProject('preview') };
    const stores = await Promise.all(['default', 'preview'].map(instance => stat(`${dataDirectory(instance)}/system/zelavis.sqlite`)));
    assert.notEqual(stores[0].ino, stores[1].ino);
    await passed(`${firstInstall}-first: independent accounts, stores, owner claims and running App Projects`);
    for (const instance of ['preview', 'default']) {
      const neighbour = instance === 'default' ? 'preview' : 'default';
      const before = await snapshot(neighbour);
      const processes = { default: await projectProcesses('default'), preview: await projectProcesses('preview') };
      let monitoring = true;
      const observations = { default: 0, preview: 0 };
      const traffic = (async () => {
        while (monitoring) {
          for (const name of ['default', 'preview']) { await bootstrap(name); observations[name]++; }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      })();
      const update = liveUpdate(instance).finally(() => { monitoring = false; });
      const outcomes = await Promise.allSettled([update, traffic]);
      for (const result of outcomes) if (result.status === 'rejected') throw result.reason;
      assert.ok(observations.default > 0 && observations.preview > 0);
      assert.deepEqual(await snapshot(neighbour), before, 'The other instance must keep its host and engine identities');
      for (const name of ['default', 'preview']) {
        await checkProject(name, projects[name]);
        assert.deepEqual(await projectProcesses(name), processes[name], 'Live updates must preserve the running App processes');
      }
      await passed(`Live Update now on ${instance}: neighbour unchanged; both Project locks and data retained`);
    }
    const survivor = firstRemove === 'default' ? 'preview' : 'default';
    const before = await snapshot(survivor);
    await remove(firstRemove); assert.deepEqual(await snapshot(survivor), before);
    await doctor(survivor); await checkProject(survivor, projects[survivor]);
    await access('/etc/systemd/system/zelavis@.service'); await access('/opt/zelavis/releases');
    await passed(`Removing ${firstRemove} preserves ${survivor}, its running Project and shared inventory`);
    await remove(survivor); await removedAll();
    await passed(`Last-instance removal after ${firstRemove}-first clears all owned inventory`);
  }
}
try {
  await prepare();
  if (phase !== 'instances') await matrix();
  if (phase === 'all' || phase === 'instances') await instances();
  report.passed = true;
  await passed(phase === 'all' ? 'Installer entry matrix and real multi-instance Project/live-update qualification complete' : `Installer ${phase} qualification complete`);
} catch (error) {
  report.error = scrub(error.stack);
  await writeFile(join(root, 'proof.json'), JSON.stringify(report, null, 2));
  console.error(report.error);
  process.exitCode = 1;
}
