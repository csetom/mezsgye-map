/**
 * Storage tests: safe names, path containment, save/load/list/delete.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { AtlasStore, StorageError, safeName } from '../src/storage.js';
import { addEdge, addNode, createEmptyGraph } from '../src/model.js';

async function tempStore() {
  const dir = await mkdtemp(path.join(tmpdir(), 'atlas-test-'));
  const store = await new AtlasStore(dir).init();
  return { dir, store };
}

function sampleGraph() {
  const graph = createEmptyGraph({ title: 'Ködrév Atlas' });
  const a = addNode(graph, { name: 'Ködrév', category: 'sector' });
  const b = addNode(graph, { name: 'Szélhalom', category: 'sector' });
  addEdge(graph, { from: a.id, to: b.id, category: 'essence_street' });
  return graph;
}

test('safeName strips paths, accents and punctuation', () => {
  assert.equal(safeName('My Atlas'), 'my-atlas');
  assert.equal(safeName('Ködrév Útvonal'), 'kodrev-utvonal');
  assert.equal(safeName('../../etc/passwd'), 'etc-passwd');
  assert.equal(safeName('already.atlas.json'), 'already');
  assert.throws(() => safeName('///'), StorageError);
  assert.throws(() => safeName(''), StorageError);
});

test('pathFor always stays inside the data directory', async () => {
  const { dir, store } = await tempStore();
  try {
    for (const attempt of ['../escape', '..%2Fescape', 'a/../../b', './x']) {
      const resolved = store.pathFor(attempt);
      assert.ok(
        resolved.startsWith(`${dir}${path.sep}`),
        `${attempt} resolved outside the data dir: ${resolved}`,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('save then load round-trips a graph', async () => {
  const { dir, store } = await tempStore();
  try {
    const saved = await store.save('Test Map', sampleGraph());
    assert.equal(saved.name, 'test-map');
    assert.ok(saved.validation.ok);

    const files = await readdir(dir);
    assert.deepEqual(files, ['test-map.atlas.json']);

    const loaded = await store.load('test-map');
    assert.equal(loaded.graph.meta.title, 'Ködrév Atlas');
    assert.equal(loaded.graph.nodes.length, 2);
    assert.equal(loaded.graph.edges.length, 1);
    assert.ok(loaded.validation.ok);
    assert.equal(await store.exists('test-map'), true);
    assert.equal(await store.exists('other'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('save refuses an invalid document', async () => {
  const { dir, store } = await tempStore();
  try {
    const broken = createEmptyGraph();
    broken.edges.push({ id: 'e1', from: 'ghost', to: 'ghost2', category: 'essence_street', data: {} });
    await assert.rejects(() => store.save('broken', broken), /invalid atlas/i);
    assert.deepEqual(await readdir(dir), [], 'nothing was written');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('list summarises stored atlases and skips junk', async () => {
  const { dir, store } = await tempStore();
  try {
    await store.save('first', sampleGraph());
    await store.save('second', sampleGraph());
    await writeFile(path.join(dir, 'notes.txt'), 'ignore me', 'utf8');
    await writeFile(path.join(dir, 'corrupt.atlas.json'), '{not json', 'utf8');

    const list = await store.list();
    const names = list.map((entry) => entry.name).sort();
    assert.deepEqual(names, ['corrupt', 'first', 'second']);
    const first = list.find((entry) => entry.name === 'first');
    assert.equal(first.title, 'Ködrév Atlas');
    assert.equal(first.nodes, 2);
    assert.equal(first.edges, 1);
    assert.ok(first.bytes > 0);
    const corrupt = list.find((entry) => entry.name === 'corrupt');
    assert.equal(corrupt.nodes, 0, 'unparseable files are listed but reported empty');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('load reports missing and corrupt files distinctly', async () => {
  const { dir, store } = await tempStore();
  try {
    await assert.rejects(() => store.load('nothing-here'), (err) => {
      assert.equal(err.status, 404);
      return true;
    });
    await writeFile(path.join(dir, 'bad.atlas.json'), '{oops', 'utf8');
    await assert.rejects(() => store.load('bad'), (err) => {
      assert.equal(err.status, 422);
      return true;
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('remove deletes a file and 404s the second time', async () => {
  const { dir, store } = await tempStore();
  try {
    await store.save('doomed', sampleGraph());
    assert.equal(await store.remove('doomed'), true);
    await assert.rejects(() => store.remove('doomed'), /No atlas named/);
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('list on a missing directory returns empty rather than throwing', async () => {
  const store = new AtlasStore(path.join(tmpdir(), `atlas-missing-${process.pid}`));
  assert.deepEqual(await store.list(), []);
});
