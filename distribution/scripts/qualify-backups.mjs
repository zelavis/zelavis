/**
 * The backup gate's steps, run as the Platform's own account inside a disposable Debian/systemd container by
 * qualify-backups-host.sh. `primary`: a WordPress Project on the candidate is backed up through its own schedule
 * while it serves, then drilled and restored, and the restored copy is the site: its files, its upload, and a dump
 * of its database that finished. `elsewhere`: a fresh machine drills that run from the target and the recovery key.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installRecipeIfAvailable } from './lib/install-recipe.mjs';

if (process.env.ZELAVIS_PROVISIONING_DISPOSABLE !== '1') throw Error('Disposable qualification only');
await readFile('/.dockerenv');
const role = process.argv[2];
const baseUrl = 'http://127.0.0.1:3000';
const handoff = '/var/lib/zelavis/backup-handoff.json';
const target = { kind: 'directory', path: '/srv/offsite' };
const password = 'Disposable Backup Password 2026!';
const { createZelavisClient } = await import(pathToFileURL('/opt/zelavis/current/platform/dist/sdk/fetch.js').href);
const cookie = await readFile('/var/lib/zelavis/qualification-session', 'utf8');
const client = createZelavisClient({ baseUrl, headers: { cookie, origin: baseUrl }, fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(900_000) }) });

async function running(id) {
  let project = await client.projects.get(id);
  for (let attempt = 0; attempt < 600 && project.runtime.status !== 'running'; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    project = await client.projects.get(id);
  }
  assert.equal(project.runtime.status, 'running', JSON.stringify(project.runtime));
  return project;
}

/** A call through the Project gateway that its integration runtime answers, retried while it starts. */
async function whenOpen(call) {
  for (let attempt = 0; ; attempt++) {
    try { return await call(); } catch (error) {
      if (attempt >= 120 || ![404, 502, 503].includes(error.status)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

if (role === 'primary') {
  await installRecipeIfAvailable({ baseUrl, cookie }, '@zelavis/wordpress');
  await client.projects.create({ id: 'shop', name: 'Shop', recipeName: '@zelavis/wordpress', installHostPackages: true });
  const project = await running('shop');
  assert.ok(project.recipe.install, 'the checkout\'s recipe, locked with an install method');
  const previewUrl = `http://127.0.0.1:${project.preview.port}`;
  const install = await fetch(`${previewUrl}/wp-admin/install.php?step=2`, { method: 'POST',
    body: new URLSearchParams({ weblog_title: 'Backed up shop', user_name: 'backup_owner', admin_password: password, admin_password2: password,
      admin_email: 'backup@example.test', blog_public: '0', pw_weak: '1', Submit: 'Install WordPress' }) });
  assert.match(await install.text(), /Success!|WordPress has been installed/i);
  const site = '/var/lib/zelavis/projects/shop/app/site';
  await writeFile(join(site, 'wp-content', 'backup-marker.txt'), 'an upload the backup must carry');

  // Visitors the whole time the backup runs: it is taken from a serving site, which must not notice.
  let finished = false; let served = 0; const failures = [];
  const traffic = (async () => {
    do {
      const status = await fetch(`${previewUrl}/`, { redirect: 'manual', signal: AbortSignal.timeout(30_000) }).then(async (page) => { await page.arrayBuffer(); return page.status; }, (error) => error.message);
      if ([200, 302, 303].includes(status)) served++; else failures.push(String(status));
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (!finished);
  })();
  const schedule = await whenOpen(() => client.projects.createBackupSchedule('shop', { name: 'offsite', cron: '0 3 * * *', keep: 3, target }));
  const run = await client.projects.runBackup('shop', 'offsite').finally(() => { finished = true; });
  await traffic;
  assert.equal(run.status, 'ok', run.error);
  assert.deepEqual(failures, [], 'the site answered every request while it was backed up');
  console.log(`PASS: WordPress backed up while serving (${run.bytes} bytes, ${served} requests answered).`);

  const verified = await client.projects.verifyBackup('shop', { schedule: 'offsite', runId: run.runId });
  assert.equal(verified.verified, true);
  const drilled = await client.projects.drillBackup('shop', { schedule: 'offsite', runId: run.runId });
  assert.equal(drilled.drill?.ok, true, JSON.stringify(drilled.drill));
  assert.deepEqual(drilled.drill.app?.captured, ['site', 'db'], JSON.stringify(drilled.drill.app));
  assert.match(drilled.drill.app.recipe, /^@zelavis\/wordpress@/);
  console.log(`PASS: drilled on this machine: ${drilled.drill.app.recipe}, site and database captured, restored in ${drilled.drill.rtoMs} ms.`);

  const restored = await client.projects.restoreBackup('shop', { schedule: 'offsite', runId: run.runId });
  const copy = restored.restoredTo;
  assert.ok(copy, JSON.stringify(restored));
  assert.equal(await readFile(join(copy, 'app/files/site/wp-content/backup-marker.txt'), 'utf8'), 'an upload the backup must carry');
  assert.match(await readFile(join(copy, 'app/files/site/wp-config.php'), 'utf8'), /DB_NAME/);
  const dump = await readFile(join(copy, 'app/recipe/database.sql'), 'utf8');
  assert.match(dump, /CREATE TABLE `wp_options`/);
  assert.match(dump, /Backed up shop/, 'the site\'s own title is in its database dump');
  assert.match(dump, /-- Dump completed/, 'the dump finished');
  const summary = JSON.parse(await readFile(join(copy, 'app/recipe.json'), 'utf8'));
  assert.deepEqual(summary.directories.map((entry) => [entry.name, entry.captured]), [['site', 'files/site'], ['db', 'recipe']]);
  console.log('PASS: the restored copy is the site: its files, its upload and a finished dump of its database.');
  await writeFile(handoff, JSON.stringify({ schedule: 'offsite', runId: run.runId, recoveryKey: schedule.recoveryKey }), { mode: 0o600 });
} else if (role === 'elsewhere') {
  const { schedule, runId, recoveryKey } = JSON.parse(await readFile('/input/handoff.json', 'utf8'));
  const drilled = await client.runtime.backups.drillFrom({ target, schedule, recoveryKey });
  assert.equal(drilled.ok, true, JSON.stringify(drilled));
  assert.equal(drilled.runId, runId, 'the run the first machine made');
  assert.deepEqual(drilled.app?.captured, ['site', 'db'], JSON.stringify(drilled.app));
  assert.ok((drilled.tenants ?? 0) >= 1, 'the Project\'s own database came back with it');
  const wrong = await client.runtime.backups.drillFrom({ target, schedule, recoveryKey: Buffer.alloc(32).toString('base64url') });
  assert.equal(wrong.ok, false, 'a key that is not the run\'s opens nothing');
  console.log(`PASS: a separate machine drilled run ${runId} from the target and the recovery key alone: RTO ${drilled.rtoMs} ms, RPO ${Math.round(drilled.rpoMs / 1000)} s.`);
} else {
  throw Error(`Unknown role ${role}`);
}
