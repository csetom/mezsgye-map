/**
 * Force layout tests — regression for the flexible-mode "place a node" crash.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { forceStep } from '../src/layout.js';
import { addEdge, addNode, createEmptyGraph, makeRng } from '../src/model.js';

const allFinite = (graph) => graph.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y));

test('a node added mid-simulation does not poison the layout with NaN', () => {
  const graph = createEmptyGraph();
  const a = addNode(graph, { category: 'sector', x: 0, y: 0 });
  const b = addNode(graph, { category: 'sector', x: 200, y: 0 });
  addEdge(graph, { from: a.id, to: b.id });
  const velocity = new Map();
  const rng = makeRng(1);

  for (let i = 0; i < 20; i += 1) forceStep(graph.nodes, graph.edges, velocity, { rng });
  // Simulates "Place" while flexible mode is running.
  addNode(graph, { category: 'world', x: 50, y: 50, parent: a.id });
  for (let i = 0; i < 50; i += 1) forceStep(graph.nodes, graph.edges, velocity, { rng });

  assert.ok(allFinite(graph), JSON.stringify(graph.nodes.map((n) => [n.x, n.y])));
});

test('non-finite coordinates are repaired rather than spread', () => {
  const graph = createEmptyGraph();
  addNode(graph, { x: 0, y: 0 });
  const bad = addNode(graph, { x: 10, y: 10 });
  bad.x = NaN;
  bad.y = null;
  forceStep(graph.nodes, graph.edges, new Map());
  assert.ok(allFinite(graph));
});

test('pinned and frozen nodes stay put; removed nodes are forgotten', () => {
  const graph = createEmptyGraph();
  const pinned = addNode(graph, { x: 0, y: 0, pinned: true });
  const held = addNode(graph, { x: 30, y: 0 });
  const free = addNode(graph, { x: 0, y: 30 });
  const velocity = new Map();
  forceStep(graph.nodes, graph.edges, velocity, { frozen: new Set([held.id]) });
  assert.deepEqual([pinned.x, pinned.y], [0, 0]);
  assert.deepEqual([held.x, held.y], [30, 0]);
  assert.notDeepEqual([free.x, free.y], [0, 30]);

  forceStep([pinned, null, held], graph.edges, velocity);
  assert.equal(velocity.has(free.id), false);
});

test('forceStep writes nothing transient onto nodes', () => {
  const graph = createEmptyGraph();
  addNode(graph, { x: 0, y: 0 });
  addNode(graph, { x: 5, y: 5 });
  forceStep(graph.nodes, graph.edges, new Map());
  for (const node of graph.nodes) {
    assert.deepEqual(Object.keys(node).filter((k) => k.startsWith('_')), []);
  }
});
