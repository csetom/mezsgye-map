/**
 * HTTP API tests. The server is imported after ATLAS_DATA is pointed at a
 * throwaway directory, then started on an ephemeral port.
 */

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { addEdge, addNode, createEmptyGraph } from '../src/model.js';

let dir;
let server;
let base;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'atlas-api-'));
  process.env.ATLAS_DATA = dir;
  const mod = await import('../server.js');
  server = await mod.start({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

function sampleGraph() {
  const graph = createEmptyGraph({ title: 'API Atlas' });
  const a = addNode(graph, { name: 'Ködrév', category: 'sector' });
  const b = addNode(graph, { name: 'Szélhalom', category: 'sector' });
  addEdge(graph, { from: a.id, to: b.id, category: 'essence_street' });
  return graph;
}

async function json(method, url, body) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

test('GET /api/health reports the data directory', async () => {
  const { status, body } = await json('GET', '/api/health');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.dataDir, dir);
});

test('GET /api/schema returns the default schema and generator defaults', async () => {
  const { status, body } = await json('GET', '/api/schema');
  assert.equal(status, 200);
  assert.ok(body.schema.nodeCategories.some((c) => c.id === 'sector'));
  assert.equal(typeof body.generatorDefaults.sectors, 'number');
});

test('POST /api/generate returns a usable atlas without saving it', async () => {
  const { status, body } = await json('POST', '/api/generate', { seed: 4, sectors: 5 });
  assert.equal(status, 200);
  assert.equal(body.graph.nodes.filter((n) => n.category === 'sector').length, 5);
  const listed = await json('GET', '/api/graphs');
  assert.equal(listed.body.graphs.length, 0, 'generation does not persist');
});

test('POST /api/validate reports errors without saving', async () => {
  const broken = createEmptyGraph();
  broken.edges.push({ id: 'e1', from: 'ghost', to: 'ghost2', category: 'essence_street', data: {} });
  const { status, body } = await json('POST', '/api/validate', { graph: broken });
  assert.equal(status, 200);
  assert.equal(body.ok, false);
  assert.ok(body.errors.length > 0);
});

test('atlas create / list / load / save / delete lifecycle', async () => {
  const created = await json('POST', '/api/graphs', { name: 'My First Map', graph: sampleGraph() });
  assert.equal(created.status, 201);
  assert.equal(created.body.name, 'my-first-map');

  const duplicate = await json('POST', '/api/graphs', { name: 'my-first-map' });
  assert.equal(duplicate.status, 409);

  const listed = await json('GET', '/api/graphs');
  assert.equal(listed.body.graphs.length, 1);
  assert.equal(listed.body.graphs[0].title, 'API Atlas');
  assert.equal(listed.body.graphs[0].nodes, 2);

  const loaded = await json('GET', '/api/graphs/my-first-map');
  assert.equal(loaded.status, 200);
  assert.equal(loaded.body.graph.meta.title, 'API Atlas');

  const edited = loaded.body.graph;
  edited.meta.title = 'Renamed Atlas';
  const saved = await json('PUT', '/api/graphs/my-first-map', { graph: edited });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.graph.meta.title, 'Renamed Atlas');

  const reloaded = await json('GET', '/api/graphs/my-first-map');
  assert.equal(reloaded.body.graph.meta.title, 'Renamed Atlas');

  const deleted = await json('DELETE', '/api/graphs/my-first-map');
  assert.equal(deleted.status, 200);
  assert.equal((await json('GET', '/api/graphs/my-first-map')).status, 404);
});

test('PUT rejects an invalid atlas with 422 and a report', async () => {
  const broken = createEmptyGraph();
  broken.nodes.push({ id: 'dup', category: 'sector', data: {} });
  broken.nodes.push({ id: 'dup', category: 'sector', data: {} });
  const { status, body } = await json('PUT', '/api/graphs/invalid', { graph: broken });
  assert.equal(status, 422);
  assert.ok(body.errors.some((e) => e.includes('duplicated')));
  assert.equal((await json('GET', '/api/graphs/invalid')).status, 404, 'nothing persisted');
});

test('a traversal-shaped atlas name is slugged, not followed', async () => {
  const res = await json('PUT', '/api/graphs/..%2F..%2Fescape', { graph: sampleGraph() });
  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'escape');
  const listed = await json('GET', '/api/graphs');
  assert.deepEqual(listed.body.graphs.map((g) => g.name), ['escape']);
  await json('DELETE', '/api/graphs/escape');
});

test('unknown endpoints and methods are refused', async () => {
  assert.equal((await json('GET', '/api/nope')).status, 404);
  assert.equal((await json('PATCH', '/api/graphs')).status, 405);
  const badBody = await fetch(`${base}/api/validate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(badBody.status, 400);
});

test('static assets are served, including the shared model module', async () => {
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(await page.text(), /Mezsgye Atlas/);

  const css = await fetch(`${base}/css/style.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);

  const shared = await fetch(`${base}/shared/model.js`);
  assert.equal(shared.status, 200);
  assert.match(shared.headers.get('content-type'), /javascript/);
  assert.match(await shared.text(), /export function createEmptyGraph/);

  const app = await fetch(`${base}/js/app.js`);
  assert.equal(app.status, 200);
});

test('static serving refuses to climb out of the public directory', async () => {
  const escaped = await fetch(`${base}/%2e%2e%2fpackage.json`);
  assert.ok([403, 404].includes(escaped.status), `got ${escaped.status}`);

  const escapedShared = await fetch(`${base}/shared/%2e%2e%2fpackage.json`);
  assert.ok([403, 404].includes(escapedShared.status), `got ${escapedShared.status}`);

  const missing = await fetch(`${base}/nope.html`);
  assert.equal(missing.status, 404);
});
