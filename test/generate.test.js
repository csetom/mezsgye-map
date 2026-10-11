/**
 * Generator tests: determinism, connectivity, structural validity.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { GENERATOR_DEFAULTS, generateAtlas } from '../src/generate.js';
import { components, graphStats, makeRng, serialize, validateGraph } from '../src/model.js';
import { createNamer } from '../src/names.js';

test('generateAtlas is deterministic for a seed', () => {
  const a = generateAtlas({ seed: 42, sectors: 9 });
  const b = generateAtlas({ seed: 42, sectors: 9 });
  assert.equal(serialize({ ...a, meta: null }), serialize({ ...b, meta: null }));
});

test('different seeds give different maps', () => {
  const a = generateAtlas({ seed: 1, sectors: 9 });
  const b = generateAtlas({ seed: 2, sectors: 9 });
  assert.notEqual(
    a.nodes.map((n) => n.name).join(),
    b.nodes.map((n) => n.name).join(),
  );
});

test('generated atlases are valid and connected across sectors', () => {
  for (const seed of [1, 5, 17, 99]) {
    const graph = generateAtlas({ seed, sectors: 12, worldsMin: 1, worldsMax: 3 });
    const report = validateGraph(graph);
    assert.ok(report.ok, `seed ${seed}: ${report.errors.join(' ')}`);

    const sectors = graph.nodes.filter((n) => n.category === 'sector');
    assert.equal(sectors.length, 12);

    // Every sector must sit in the same connected component.
    const sectorIds = new Set(sectors.map((n) => n.id));
    const group = components(graph).find((g) => g.some((id) => sectorIds.has(id)));
    for (const id of sectorIds) {
      assert.ok(group.includes(id), `seed ${seed}: sector ${id} is stranded`);
    }
  }
});

test('worlds are nested inside sectors', () => {
  const graph = generateAtlas({ seed: 3, sectors: 5, worldsMin: 2, worldsMax: 2 });
  const worlds = graph.nodes.filter((n) => n.category === 'world');
  assert.equal(worlds.length, 10);
  const sectorIds = new Set(graph.nodes.filter((n) => n.category === 'sector').map((n) => n.id));
  for (const world of worlds) {
    assert.ok(sectorIds.has(world.parent), 'each world has a sector parent');
  }
});

test('single-sector and no-world edge cases work', () => {
  const lone = generateAtlas({ seed: 1, sectors: 1, worldsMin: 0, worldsMax: 0 });
  assert.equal(lone.nodes.filter((n) => n.category === 'sector').length, 1);
  assert.ok(validateGraph(lone).ok);

  const bare = generateAtlas({ seed: 2, sectors: 4, worldsMin: 0, worldsMax: 0 });
  assert.equal(bare.nodes.filter((n) => n.category === 'world').length, 0);
  assert.ok(validateGraph(bare).ok);
});

test('sector count is clamped to a sane range', () => {
  assert.equal(generateAtlas({ sectors: 0 }).nodes.filter((n) => n.category === 'sector').length, 1);
  const huge = generateAtlas({ sectors: 5000, worldsMin: 0, worldsMax: 0 });
  assert.equal(huge.nodes.filter((n) => n.category === 'sector').length, 200);
  assert.equal(huge.nodes.filter((n) => n.category === 'world').length, 0);
});

test('generated nodes carry populated category fields', () => {
  const graph = generateAtlas({ seed: 11, sectors: 6 });
  const sector = graph.nodes.find((n) => n.category === 'sector');
  assert.ok(['dead', 'thin', 'stable', 'rich', 'volatile'].includes(sector.data.essence_density));
  assert.ok(Array.isArray(sector.data.hazards));
  const street = graph.edges.find((e) => e.category === 'essence_street');
  assert.ok(street.notes.length > 0, 'streets get a flavour name in notes');
  assert.ok(Number.isFinite(street.data.cost));
});

test('generator defaults are exposed for the UI', () => {
  assert.equal(typeof GENERATOR_DEFAULTS.sectors, 'number');
  assert.equal(typeof GENERATOR_DEFAULTS.seed, 'number');
});

test('graphStats on a generated atlas reports one cluster of sectors', () => {
  const graph = generateAtlas({ seed: 8, sectors: 10 });
  const stats = graphStats(graph);
  assert.equal(stats.nodes, graph.nodes.length);
  assert.equal(stats.edges, graph.edges.length);
  assert.ok(stats.components >= 1);
});

test('makeRng is reproducible and bounded', () => {
  const a = makeRng(5);
  const b = makeRng(5);
  for (let i = 0; i < 100; i += 1) {
    const value = a();
    assert.equal(value, b());
    assert.ok(value >= 0 && value < 1);
  }
});

test('namer avoids repeats within one run', () => {
  const namer = createNamer(makeRng(1));
  const names = new Set();
  for (let i = 0; i < 60; i += 1) names.add(namer.sector());
  assert.equal(names.size, 60, 'sector names are unique');
  assert.match(namer.world('Ködrév', 1), /\S/);
  assert.match(namer.station(), /állomás$/);
  assert.match(namer.anomaly(), /anomália$/);
});
