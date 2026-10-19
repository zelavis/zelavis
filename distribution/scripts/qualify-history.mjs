/**
 * The long-history gate's steps, run inside the disposable Debian/systemd container by
 * qualify-history-host.sh: apps made by old releases are carried forward by live updates and must keep
 * serving, and on the candidate every recipe upgrade must answer every request. Each phase is one step;
 * what the steps share is kept in a state file.
 */
import assert from 'node:assert/strict';
import { readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installRecipeIfAvailable } from './lib/install-recipe.mjs';

if (process.env.ZELAVIS_PROVISIONING_DISPOSABLE !== '1') throw Error('Disposable qualification only');
await readFile('/.dockerenv');
const phase = process.argv[2];
const baseUrl = 'http://127.0.0.1:3000';
const stateFile = '/var/lib/zelavis/history-state.json';
const projects = '/var/lib/zelavis/projects';
const password = 'Disposable History Password 2026!';
const readState = async () => JSON.parse(await readFile(stateFile, 'utf8').catch(() => '{}'));
const saveState = async (state) => writeFile(stateFile, JSON.stringify(state));

async function sdk() {
  const { createZelavisClient } = await import(pathToFileURL('/opt/zelavis/current/platform/dist/sdk/fetch.js').href);
  const cookie = await readFile('/var/lib/zelavis/qualification-session', 'utf8');
  return { cookie, client: createZelavisClient({ baseUrl, headers: { cookie, origin: baseUrl },
    fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(300_000) }) }) };
}

async function running(client, id) {
  let project = await client.projects.get(id);
  for (let attempt = 0; attempt < 240 && project.runtime.status !== 'running'; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    project = await client.projects.get(id);
  }
  assert.equal(project.runtime.status, 'running', JSON.stringify(project.runtime));
  return project;
}

/** What opening a Project in the dashboard does: its runtime is asked through the Project gateway, which starts its integration host. */
async function open(cookie, id) {
  for (const path of ['/zelavis/api/v1/runtime/config', '/zelavis/api/v1/runtime/access']) {
    // A Project just made or updated may still be starting its runtime; the dashboard asks again, so does this.
    let status = 0;
    for (let attempt = 0; attempt < 120 && status !== 200; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 500));
      const response = await fetch(`${baseUrl}/zelavis/api/v1/runtime/projects/${id}/proxy${path}`, { headers: { cookie, origin: baseUrl } });
      await response.arrayBuffer();
      status = response.status;
    }
    assert.equal(status, 200, `opening ${id}: ${path}`);
  }
}

async function login(previewUrl) {
  const page = await fetch(`${previewUrl}/wp-login.php`);
  const cookies = page.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  const answer = await fetch(`${previewUrl}/wp-login.php`, { method: 'POST', redirect: 'manual', headers: { cookie: cookies },
    body: new URLSearchParams({ log: 'history_owner', pwd: password, testcookie: '1', redirect_to: `${previewUrl}/wp-admin/` }) });
  assert.equal(answer.status, 302, "the owner's WordPress password still logs in");
}

/** Visitors on every site for as long as `operation` runs; one unanswered request fails the gate. */
async function underTraffic(urls, operation, label) {
  let finished = false; let served = 0; const failures = []; const started = Date.now();
  const traffic = Promise.all(urls.map(async (url) => {
    do {
      try {
        const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(60_000) });
        await response.arrayBuffer();
        if ([200, 302, 303].includes(response.status)) served++; else failures.push(`${url} ${response.status} at ${Date.now() - started}ms`);
      } catch (error) { failures.push(`${url} ${error.message} at ${Date.now() - started}ms`); }
      await new Promise((resolve) => setTimeout(resolve, 25));
    } while (!finished);
  }));
  const result = await operation().finally(() => { finished = true; });
  await traffic;
  console.log(`TRAFFIC: ${label}: ${served} answered, ${failures.length} failed, ${Date.now() - started}ms`);
  assert.deepEqual(failures, [], `${label}: every request is answered`);
  return result;
}

const sites = (state) => Object.values(state.sites ?? {});

if (phase === 'create-wordpress') {
  const { cookie, client } = await sdk();
  await installRecipeIfAvailable({ baseUrl, cookie }, '@zelavis/wordpress');
  await client.projects.create({ id: 'blogger', name: 'Blogger', recipeName: '@zelavis/wordpress', installHostPackages: true });
  const project = await running(client, 'blogger');
  const previewUrl = `http://127.0.0.1:${project.preview.port}`;
  const install = await fetch(`${previewUrl}/wp-admin/install.php?step=2`, { method: 'POST',
    body: new URLSearchParams({ weblog_title: 'Blogger', user_name: 'history_owner', admin_password: password, admin_password2: password,
      admin_email: 'history@example.test', blog_public: '0', pw_weak: '1', Submit: 'Install WordPress' }) });
  assert.match(await install.text(), /Success!|WordPress has been installed/i);
  await login(previewUrl);
  // An upload WordPress made, which no upgrade may rewrite or lose.
  const site = project.recipe.install ? join(projects, 'blogger', 'app', 'site') : join(projects, 'blogger', '.zelavis', 'wordpress');
  const marker = join(site, 'wp-content', 'history-marker.txt');
  await writeFile(marker, 'an upload from before every update');
  const { ino, mtimeMs } = await stat(marker);
  await open(cookie, 'blogger');
  await saveState({ sites: { blogger: { id: 'blogger', kind: 'wordpress', previewUrl, created: project.recipe.version, marker: { ino, mtimeMs } } } });
} else if (phase === 'create-dokuwiki') {
  const { cookie, client } = await sdk();
  await installRecipeIfAvailable({ baseUrl, cookie }, '@zelavis/dokuwiki');
  await client.projects.create({ id: 'wiki', name: 'Wiki', recipeName: '@zelavis/dokuwiki', installHostPackages: true });
  const project = await running(client, 'wiki');
  await open(cookie, 'wiki');
  const state = await readState();
  state.sites.wiki = { id: 'wiki', kind: 'dokuwiki', previewUrl: `http://127.0.0.1:${project.preview.port}`, created: project.recipe.version };
  await saveState(state);
} else if (phase === 'open') {
  const { cookie } = await sdk();
  for (const site of sites(await readState())) await open(cookie, site.id);
} else if (phase === 'serving') {
  const { client } = await sdk();
  for (const site of sites(await readState())) {
    const project = await running(client, site.id);
    assert.equal(project.runtimeUpdate, undefined, `${site.id} has no unfinished update`);
    // Right after a Platform start a preview may still be opening; within a minute every site answers.
    let status = 'none';
    for (let attempt = 0; attempt < 120 && ![200, 302, 303].includes(status); attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 500));
      status = await fetch(`${site.previewUrl}/`, { redirect: 'manual', signal: AbortSignal.timeout(10_000) })
        .then(async (page) => { await page.arrayBuffer(); return page.status; }, (error) => error.message);
    }
    assert.ok([200, 302, 303].includes(status), `${site.id} serves: ${status}`);
  }
} else if (phase === 'candidate') {
  const { updateToLocalCandidate } = await import('./lib/candidate-update.mjs');
  await updateToLocalCandidate({ previous: await realpath('/opt/zelavis/current'), to: process.env.ZELAVIS_HISTORY_TO, baseUrl });
  const agent = JSON.parse(await readFile('/var/lib/zelavis/agent/agent.json', 'utf8'));
  assert.equal(agent.release, process.env.ZELAVIS_HISTORY_TO);
  assert.equal(agent.survivable, true);
  const { client } = await sdk();
  const status = await client.updates.status();
  assert.equal(status.run.state, 'succeeded', JSON.stringify(status));
  assert.match(status.run.message, /Projects restarted once/);
  console.log('PASS: historical Agent conversion is explicit and desired Projects recovered.');

} else if (phase === 'unlist') {
  // Run as root with the Platform stopped: the server forgets it installed WordPress, as one whose WordPress
  // came with an earlier Platform never had it installed.
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync('/var/lib/zelavis/system/zelavis.sqlite');
  const row = database.prepare("SELECT value_json FROM zelavis_system_records WHERE namespace = 'services' AND record_key = 'registry'").get();
  const value = JSON.parse(row.value_json);
  value.services = value.services.filter((entry) => entry.name !== '@zelavis/wordpress');
  value.revision = crypto.randomUUID();
  database.prepare("UPDATE zelavis_system_records SET value_json = ?, updated_at = ? WHERE namespace = 'services' AND record_key = 'registry'")
    .run(JSON.stringify(value), new Date().toISOString());
  database.close();
} else if (phase === 'upgrade') {
  const { client } = await sdk();
  const state = await readState();
  const urls = sites(state).flatMap((site) => [`${site.previewUrl}/`, ...(site.kind === 'wordpress' ? [`${site.previewUrl}/wp-login.php`] : [])]);
  for (const site of sites(state)) {
    const before = await client.projects.get(site.id);
    assert.equal(before.recipeStatus?.state, 'upgradeAvailable', `${site.id}: ${JSON.stringify(before.recipeStatus)}`);
    // Every site stays under traffic while each one upgrades, the dashboard's Update recipe.
    const upgraded = await underTraffic(urls, () => client.projects.upgrade(site.id, { restart: true }), `Update recipe ${site.id}`);
    assert.equal(upgraded.runtime.status, 'running');
    assert.ok(upgraded.recipe.install?.method, `${site.id} is locked with an install method`);
    assert.equal(upgraded.recipeStatus?.state, 'current');
    const app = (await readdir(join(projects, site.id, 'app'))).sort();
    assert.deepEqual(app, site.kind === 'wordpress' ? ['db', 'site'] : ['site'], `${site.id}: app/ holds the application alone`);
    if (site.kind === 'wordpress') {
      const { ino, mtimeMs } = await stat(join(projects, site.id, 'app', 'site', 'wp-content', 'history-marker.txt'));
      assert.deepEqual({ ino, mtimeMs }, site.marker, 'the same upload, never rewritten');
      await login(site.previewUrl);
    }
    console.log(`PASS: ${site.id} upgraded from ${before.recipe.version} (made as ${site.created}) to ${upgraded.recipe.version} without a failed request.`);
  }
} else {
  throw Error(`Unknown phase ${phase}`);
}
