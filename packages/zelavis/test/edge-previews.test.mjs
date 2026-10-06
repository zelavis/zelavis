import assert from 'node:assert/strict';
import test from 'node:test';
import { createZelavisEdgePreviews } from '../dist/edge/previews.js';
import { createNodeEdgePreviewHost } from '../dist/adapters/_node-edge-previews.js';
import { createMemorySystemStore } from '../dist/system-store.js';
const running = { id: 'wordpress', runtime: { status: 'running', url: 'http://127.0.0.1:1' } };

test('preview publishes POST traffic, retains its port across restarts, and deletes its intent', async () => {
  const store = createMemorySystemStore();
  const host = createNodeEdgePreviewHost('127.0.0.1');
  let edge = createZelavisEdgePreviews({store, host});
  try {
    edge.configure(async (id, request) => new Response(`${id}:${new URL(request.url).protocol}:${await request.text()}`));
    const [preview, same] = await Promise.all([edge.synchronize(running), edge.synchronize(running)]);
    assert.deepEqual(same, preview);
    const url = `http://127.0.0.1:${preview.port}/`;
    assert.equal(await (await fetch(url, {method:'POST', body:'hello', headers:{'x-forwarded-proto':'https'}})).text(), 'wordpress:http::hello');
    await edge.synchronize({...running, runtime:{status:'stopped'}});
    await assert.rejects(fetch(url));
    assert.equal((await edge.synchronize(running)).port, preview.port);
    await edge.close();
    edge = createZelavisEdgePreviews({store, host});
    assert.equal((await edge.synchronize(running)).port, preview.port);
    await edge.remove(running.id);
    assert.equal(await store.get('edge.previews', running.id), undefined);
    await assert.rejects(fetch(url));
  } finally { await edge.close(); }
});

test('an occupied saved port is refused without changing intent or runtime', async () => {
  const store = createMemorySystemStore();
  const host = createNodeEdgePreviewHost('127.0.0.1');
  const occupied = await host.open({port:0,fetch:async()=>new Response('other application')});
  const intent = {projectId:running.id,port:occupied.port,protocol:'http'};
  await store.set('edge.previews',running.id,intent);
  const edge = createZelavisEdgePreviews({store,host});
  try {
    assert.equal((await edge.synchronize(running)).status,'unavailable');
    assert.deepEqual((await store.get('edge.previews',running.id)).value,intent);
    assert.equal(running.runtime.status,'running');
    assert.equal(await (await fetch(`http://127.0.0.1:${occupied.port}`)).text(),'other application');
  } finally { await edge.close(); await occupied.close(); }
});

test('owned frontends and remote placements do not open local listeners', async () => {
  const edge = createZelavisEdgePreviews({store:createMemorySystemStore(),host:{open:async()=>{throw Error('must not bind')}}});
  assert.equal(await edge.synchronize({...running,ownerProjectId:'parent'}),undefined);
  assert.equal((await edge.synchronize({...running,placement:{nodeId:'remote'}})).status,'unavailable');
  await edge.close();
});
