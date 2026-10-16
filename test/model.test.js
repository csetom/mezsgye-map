/**
 * Core model tests: CRUD, containment, validation, schema extension, routing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SCHEMA_VERSION,
  addEdge,
  addEdgeCategory,
  addField,
  addNode,
  addNodeCategory,
  childrenOf,
  components,
  countUsage,
  createEmptyGraph,
  defaultSchema,
  deserialize,
  edgeCost,
  findRoute,
  formatDuration,
  nodeColor,
  parseDuration,
  getEdge,
  getNode,
  graphStats,
  makeId,
  neighborsOf,
  normalizeGraph,
  removeCategory,
  removeEdge,
  removeField,
  removeNode,
  serialize,
  slugify,
  updateCategory,
  updateEdge,
  updateField,
  updateNode,
  validateGraph,
} from '../src/model.js';

/** Small fixture: two sectors joined by one street, one world inside sector A. */
function fixture() {
  const graph = createEmptyGraph({ title: 'Test Atlas' });
  const a = addNode(graph, { name: 'Ködrév', category: 'sector', x: 0, y: 0 });
  const b = addNode(graph, { name: 'Szélhalom', category: 'sector', x: 300, y: 0 });
  const w = addNode(graph, { name: 'Ködrév II', category: 'world', parent: a.id, x: 60, y: 40 });
  const e = addEdge(graph, { from: a.id, to: b.id, category: 'essence_street' });
  return { graph, a, b, w, e };
}

test('createEmptyGraph produces a valid, versioned document', () => {
  const graph = createEmptyGraph({ title: 'Mine' });
  assert.equal(graph.schemaVersion, SCHEMA_VERSION);
  assert.equal(graph.meta.title, 'Mine');
  assert.deepEqual(graph.nodes, []);
  assert.deepEqual(graph.edges, []);
  assert.ok(graph.schema.nodeCategories.length > 0);
  assert.ok(validateGraph(graph).ok);
});

test('default schema carries the setting categories', () => {
  const schema = defaultSchema();
  assert.deepEqual(
    schema.nodeCategories.map((c) => c.id),
    ['sector', 'world', 'waystation', 'island', 'anomaly'],
  );
  assert.deepEqual(
    schema.edgeCategories.map((c) => c.id),
    ['essence_street', 'minor_current', 'collapsed_route'],
  );
});

test('addNode seeds field defaults from its category', () => {
  const { graph, a } = fixture();
  assert.equal(a.data.essence_density, 'stable');
  assert.equal(a.data.access, 'open');
  assert.deepEqual(a.data.hazards, []);
  assert.equal(countUsage(graph, 'node', 'sector'), 2);
});

test('addNode falls back to the first category when given an unknown one', () => {
  const graph = createEmptyGraph();
  const node = addNode(graph, { category: 'nope' });
  assert.equal(node.category, 'sector');
});

test('ids are unique even when a caller forces a collision', () => {
  const graph = createEmptyGraph();
  const first = addNode(graph, { id: 'n1' });
  const second = addNode(graph, { id: 'n1' });
  assert.equal(first.id, 'n1');
  assert.notEqual(second.id, 'n1');
  assert.equal(makeId('n', ['n1', 'n2']), 'n3');
});

test('updateNode keeps shared field values across a category change', () => {
  const { graph, a } = fixture();
  updateNode(graph, a.id, { data: { ruling_power: 'Guild of Ash', hazards: ['wave shear'] } });
  updateNode(graph, a.id, { category: 'waystation' });
  const after = getNode(graph, a.id);
  assert.equal(after.category, 'waystation');
  assert.equal(after.data.ruling_power, undefined, 'field not on the new category is dropped');
  assert.equal(after.data.safety, 'neutral', 'new category defaults are seeded');
});

test('updateNode refuses containment cycles', () => {
  const { graph, a, w } = fixture();
  assert.throws(() => updateNode(graph, a.id, { parent: w.id }), /cycle/i);
  assert.throws(() => updateNode(graph, a.id, { parent: a.id }), /own parent/i);
});

test('removeNode cascades to children and incident edges', () => {
  const { graph, a, w, e } = fixture();
  const result = removeNode(graph, a.id);
  assert.deepEqual(result.nodes.sort(), [a.id, w.id].sort());
  assert.deepEqual(result.edges, [e.id]);
  assert.equal(graph.nodes.length, 1);
  assert.equal(graph.edges.length, 0);
});

test('childrenOf and neighborsOf read the structure back', () => {
  const { graph, a, b, w } = fixture();
  assert.deepEqual(childrenOf(graph, a.id).map((n) => n.id), [w.id]);
  const neighbours = neighborsOf(graph, a.id);
  assert.equal(neighbours.length, 1);
  assert.equal(neighbours[0].node.id, b.id);
});

test('addEdge rejects self-links and unknown endpoints', () => {
  const { graph, a } = fixture();
  assert.throws(() => addEdge(graph, { from: a.id, to: a.id }), /loop back/i);
  assert.throws(() => addEdge(graph, { from: a.id, to: 'ghost' }), /No such node/);
});

test('updateEdge can be rerouted and recategorised', () => {
  const { graph, a, b, w, e } = fixture();
  updateEdge(graph, e.id, { to: w.id, category: 'minor_current' });
  const after = getEdge(graph, e.id);
  assert.equal(after.to, w.id);
  assert.equal(after.category, 'minor_current');
  assert.equal(after.data.stability, 'intermittent');
  assert.throws(() => updateEdge(graph, e.id, { from: w.id }), /loop back/i);
  assert.equal(removeEdge(graph, e.id), true);
  assert.equal(removeEdge(graph, e.id), false);
  assert.equal(graph.nodes.length, 3);
  assert.ok(b);
});

/* ------------------------------------------------- expandable schema */

test('a new node category with new fields becomes usable immediately', () => {
  const graph = createEmptyGraph();
  const cat = addNodeCategory(graph, {
    label: 'Void Maker Berth',
    color: '#ff00aa',
    shape: 'star',
    size: 20,
    fields: [
      { key: 'crew', label: 'Crew', type: 'text' },
      { key: 'slips', label: 'Slips', type: 'number', default: 3 },
    ],
  });
  assert.equal(cat.id, 'void_maker_berth');
  assert.equal(cat.shape, 'star');
  const node = addNode(graph, { category: cat.id, name: 'Berth 9' });
  assert.equal(node.data.slips, 3);
  assert.ok(validateGraph(graph).ok);
});

test('addField back-fills defaults onto existing items', () => {
  const { graph, a, b } = fixture();
  addField(graph, 'node', 'sector', { label: 'Tithe owed', type: 'number', default: 0 });
  assert.equal(getNode(graph, a.id).data.tithe_owed, 0);
  assert.equal(getNode(graph, b.id).data.tithe_owed, 0);
  assert.throws(
    () => addField(graph, 'node', 'sector', { label: 'Tithe owed', type: 'text' }),
    /already exists/,
  );
  assert.throws(
    () => addField(graph, 'node', 'sector', { label: 'Mood', type: 'select', options: [] }),
    /at least one option/,
  );
});

test('renaming a field key migrates stored values', () => {
  const { graph, a } = fixture();
  updateNode(graph, a.id, { data: { ruling_power: 'The Council' } });
  updateField(graph, 'node', 'sector', 'ruling_power', { key: 'owner', label: 'Owner' });
  const after = getNode(graph, a.id);
  assert.equal(after.data.owner, 'The Council');
  assert.equal(after.data.ruling_power, undefined);
});

test('removeField purges values, and category edits stick', () => {
  const { graph, a } = fixture();
  removeField(graph, 'node', 'sector', 'hazards');
  assert.equal(getNode(graph, a.id).data.hazards, undefined);
  updateCategory(graph, 'node', 'sector', { label: 'Region', color: '#123456', shape: 'diamond' });
  assert.equal(graph.schema.nodeCategories[0].label, 'Region');
  assert.equal(graph.schema.nodeCategories[0].shape, 'diamond');
});

test('removeCategory guards in-use categories and the last category', () => {
  const { graph } = fixture();
  assert.throws(() => removeCategory(graph, 'node', 'sector'), /used by 2 item/);
  removeCategory(graph, 'node', 'sector', 'waystation');
  assert.equal(countUsage(graph, 'node', 'waystation'), 2);
  assert.ok(!graph.schema.nodeCategories.some((c) => c.id === 'sector'));

  const tiny = createEmptyGraph({ schema: { nodeCategories: [{ id: 'only', label: 'Only' }], edgeCategories: [{ id: 'l', label: 'L' }] } });
  assert.throws(() => removeCategory(tiny, 'node', 'only'), /last node category/);
});

test('an edge category added at runtime is honoured by addEdge', () => {
  const { graph, a, b } = fixture();
  addEdgeCategory(graph, {
    label: 'Smuggler Thread',
    color: '#00ffcc',
    style: 'dotted',
    fields: [{ key: 'cost', label: 'Cost', type: 'number', default: 5 }],
  });
  const edge = addEdge(graph, { from: a.id, to: b.id, category: 'smuggler_thread' });
  assert.equal(edge.category, 'smuggler_thread');
  assert.equal(edgeCost(edge), 5);
});

test('slugify normalises accents and punctuation', () => {
  assert.equal(slugify('Mezsgye Útvonal!'), 'mezsgye_utvonal');
  assert.equal(slugify('   '), 'item');
});

/* ---------------------------------------------------------- analysis */

test('findRoute picks the cheapest path and honours exclusions', () => {
  const graph = createEmptyGraph();
  const a = addNode(graph, { name: 'A', category: 'sector' });
  const b = addNode(graph, { name: 'B', category: 'sector' });
  const c = addNode(graph, { name: 'C', category: 'sector' });
  // Direct but expensive, versus a cheap two-hop detour.
  addEdge(graph, { from: a.id, to: c.id, category: 'essence_street', data: { cost: 10 } });
  addEdge(graph, { from: a.id, to: b.id, category: 'essence_street', data: { cost: 1 } });
  addEdge(graph, { from: b.id, to: c.id, category: 'essence_street', data: { cost: 1 } });

  const route = findRoute(graph, a.id, c.id);
  assert.equal(route.cost, 2);
  assert.deepEqual(route.nodes, [a.id, b.id, c.id]);
  assert.equal(route.edges.length, 2);

  assert.deepEqual(findRoute(graph, a.id, a.id), { nodes: [a.id], edges: [], cost: 0 });
  assert.equal(findRoute(graph, a.id, 'ghost'), null);

  const walled = createEmptyGraph();
  const x = addNode(walled, { category: 'sector' });
  const y = addNode(walled, { category: 'sector' });
  addEdge(walled, { from: x.id, to: y.id, category: 'collapsed_route' });
  assert.equal(findRoute(walled, x.id, y.id, { exclude: ['collapsed_route'] }), null);
  assert.ok(findRoute(walled, x.id, y.id));
});

test('components and graphStats describe the map', () => {
  const { graph } = fixture();
  assert.equal(components(graph).length, 2, 'the linked pair plus the unlinked world');
  const stats = graphStats(graph);
  assert.equal(stats.nodes, 3);
  assert.equal(stats.edges, 1);
  assert.equal(stats.byNodeCategory.sector, 2);
  assert.equal(stats.byNodeCategory.world, 1);
  assert.equal(stats.byEdgeCategory.essence_street, 1);
  assert.equal(stats.isolated, 0, 'the world is contained, so not counted as isolated');
});

/* ----------------------------------------------- validate / normalise */

test('validateGraph reports structural errors', () => {
  assert.equal(validateGraph(null).ok, false);
  assert.equal(validateGraph({ nodes: [], edges: [] }).ok, false);

  const graph = createEmptyGraph();
  graph.nodes.push({ id: 'dup', name: 'A', category: 'sector', data: {} });
  graph.nodes.push({ id: 'dup', name: 'B', category: 'sector', data: {} });
  graph.edges.push({ id: 'e1', from: 'dup', to: 'ghost', category: 'essence_street', data: {} });
  const report = validateGraph(graph);
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((e) => e.includes('duplicated')));
  assert.ok(report.errors.some((e) => e.includes('not a known node')));
});

test('validateGraph warns about unknown categories and version drift', () => {
  const graph = createEmptyGraph();
  graph.schemaVersion = 0;
  graph.nodes.push({ id: 'n1', name: 'X', category: 'mystery', data: {} });
  const report = validateGraph(graph);
  assert.equal(report.ok, true);
  assert.ok(report.warnings.some((w) => w.includes('schemaVersion')));
  assert.ok(report.warnings.some((w) => w.includes('unknown category')));
});

test('normalizeGraph repairs junk input instead of throwing', () => {
  const graph = normalizeGraph({
    nodes: [
      { id: 'a', name: 'A', category: 'sector', x: 'oops', parent: 'nowhere' },
      { id: 'a', name: 'Duplicate id', category: 'bogus' },
      'not an object',
    ],
    edges: [
      { id: 'e', from: 'a', to: 'a' },
      { id: 'e2', from: 'a', to: 'missing' },
    ],
    extraneous: true,
  });
  assert.equal(graph.nodes.length, 3);
  assert.equal(new Set(graph.nodes.map((n) => n.id)).size, 3, 'duplicate ids are reallocated');
  assert.equal(graph.nodes[0].x, 0, 'non-numeric coordinates fall back to 0');
  assert.equal(graph.nodes[0].parent, null, 'dangling parent cleared');
  assert.equal(graph.nodes[1].category, 'sector', 'unknown category replaced by the first one');
  assert.equal(graph.edges.length, 0, 'self-links and dangling edges dropped');
  assert.equal(graph.extraneous, undefined, 'unknown top-level keys dropped');
  assert.ok(validateGraph(graph).ok);
});

test('normalizeGraph breaks parent cycles', () => {
  const graph = normalizeGraph({
    nodes: [
      { id: 'a', category: 'sector', parent: 'b' },
      { id: 'b', category: 'sector', parent: 'a' },
    ],
    edges: [],
  });
  const parents = graph.nodes.map((n) => n.parent);
  assert.ok(parents.includes(null), 'at least one link in the cycle is cut');
});

test('serialize/deserialize round-trips a document', () => {
  const { graph } = fixture();
  const text = serialize(graph);
  const { graph: back, validation } = deserialize(text);
  assert.ok(validation.ok);
  assert.deepEqual(back.nodes.map((n) => n.name), graph.nodes.map((n) => n.name));
  assert.deepEqual(back.edges.map((e) => e.id), graph.edges.map((e) => e.id));
  assert.equal(back.meta.title, 'Test Atlas');
  assert.deepEqual(
    back.schema.nodeCategories.map((c) => c.id),
    graph.schema.nodeCategories.map((c) => c.id),
  );
});

test('deserialize throws on non-JSON', () => {
  assert.throws(() => deserialize('{nope'), SyntaxError);
});

/* ------------------------------------------------- travel time (hours) */

test('parseDuration reads hours, days, weeks and months (EN + HU)', () => {
  assert.equal(parseDuration('36'), 36);
  assert.equal(parseDuration(36), 36);
  assert.equal(parseDuration('36h'), 36);
  assert.equal(parseDuration('2d 6h'), 54);
  assert.equal(parseDuration('2 days, 6 hours'), 54);
  assert.equal(parseDuration('1 month 3 days'), 720 + 72);
  assert.equal(parseDuration('1mo'), 720);
  assert.equal(parseDuration('1 week'), 168);
  assert.equal(parseDuration('1,5 nap'), 36);
  assert.equal(parseDuration('2 hónap és 1 óra'), 1441);
  assert.equal(parseDuration(''), null);
  assert.equal(parseDuration('3 watches'), null);
  assert.equal(parseDuration('soon'), null);
  assert.equal(parseDuration(-4), null);
});

test('formatDuration rolls hours up into days and months', () => {
  assert.equal(formatDuration(5), '5 hours');
  assert.equal(formatDuration(1), '1 hour');
  assert.equal(formatDuration(24), '1 day');
  assert.equal(formatDuration(54), '2 days 6 hours');
  assert.equal(formatDuration(720 + 25), '1 month 1 day 1 hour');
  assert.equal(formatDuration(1500, { compact: true }), '2mo 2d 12h');
  assert.equal(formatDuration(0), '0 hours');
  assert.equal(formatDuration(null), '');
  assert.equal(parseDuration(formatDuration(1234.5)), 1234.5);
});

test('default link categories carry one travel-time field in hours', () => {
  const schema = defaultSchema();
  for (const id of ['essence_street', 'minor_current']) {
    const cat = schema.edgeCategories.find((c) => c.id === id);
    const cost = cat.fields.find((f) => f.key === 'cost');
    assert.equal(cost.type, 'duration');
    assert.equal(cost.label, 'Travel time');
    assert.equal(cat.fields.some((f) => f.key === 'travel_time'), false);
  }
});

test('findRoute returns the shortest total travel time', () => {
  const graph = createEmptyGraph();
  const a = addNode(graph, { category: 'sector' });
  const b = addNode(graph, { category: 'sector' });
  const c = addNode(graph, { category: 'sector' });
  addEdge(graph, { from: a.id, to: c.id, data: { cost: parseDuration('1 month') } });
  addEdge(graph, { from: a.id, to: b.id, data: { cost: parseDuration('3d') } });
  addEdge(graph, { from: b.id, to: c.id, data: { cost: parseDuration('4d 12h') } });
  const route = findRoute(graph, a.id, c.id);
  assert.deepEqual(route.nodes, [a.id, b.id, c.id]);
  assert.equal(formatDuration(route.cost), '7 days 12 hours');
});

test('v1 documents migrate travel cost + travel time into hours', () => {
  const v1 = {
    schemaVersion: 1,
    schema: {
      nodeCategories: [{ id: 'sector', label: 'Sector' }],
      edgeCategories: [{
        id: 'essence_street',
        label: 'Essence street',
        fields: [
          { key: 'cost', label: 'Travel cost', type: 'number', default: 1 },
          { key: 'travel_time', label: 'Travel time', type: 'text' },
          { key: 'toll', label: 'Toll', type: 'text' },
        ],
      }],
    },
    nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    edges: [
      { id: 'e1', from: 'a', to: 'b', category: 'essence_street', data: { cost: 2, travel_time: '5 days' } },
      { id: 'e2', from: 'b', to: 'c', category: 'essence_street', data: { cost: 3, travel_time: '3 watches' } },
      { id: 'e3', from: 'a', to: 'c', category: 'essence_street', data: { cost: 4 } },
    ],
  };
  const report = validateGraph(v1);
  assert.ok(report.ok);
  assert.ok(report.warnings.some((w) => /migrated/.test(w)));

  const graph = normalizeGraph(v1);
  assert.equal(graph.schemaVersion, SCHEMA_VERSION);
  const fields = graph.schema.edgeCategories[0].fields;
  assert.deepEqual(fields.map((f) => f.key), ['cost', 'toll']);
  assert.equal(fields[0].type, 'duration');
  assert.equal(fields[0].label, 'Travel time');

  const [e1, e2, e3] = graph.edges;
  assert.equal(e1.data.cost, 120, 'parseable travel time wins');
  assert.equal(e2.data.cost, 3, 'unreadable travel time keeps old cost');
  assert.match(e2.data.description, /3 watches/, 'unreadable text is preserved');
  assert.equal(e3.data.cost, 4);
  for (const e of graph.edges) assert.equal('travel_time' in e.data, false);

  // Idempotent: a migrated document is left alone on the next load.
  assert.deepEqual(normalizeGraph(graph).edges, graph.edges);
});

test('v2 documents keep a user-defined travel_time field untouched', () => {
  const graph = createEmptyGraph();
  addField(graph, 'edge', 'essence_street', { key: 'travel_time', label: 'Notes on time', type: 'text' });
  const again = normalizeGraph(JSON.parse(serialize(graph)));
  const cat = again.schema.edgeCategories.find((c) => c.id === 'essence_street');
  assert.ok(cat.fields.some((f) => f.key === 'travel_time'));
});

/* ------------------------------------------------- per-node colour */

test('nodes can override their category colour and reset it', () => {
  const { graph, a } = fixture();
  const sectorColor = graph.schema.nodeCategories.find((c) => c.id === 'sector').color;
  assert.equal(a.color, null);
  assert.equal(nodeColor(graph, a), sectorColor);

  updateNode(graph, a.id, { color: '#FF8800' });
  assert.equal(a.color, '#ff8800');
  assert.equal(nodeColor(graph, a), '#ff8800');

  // Category colour edits do not clobber the override…
  updateCategory(graph, 'node', 'sector', { color: '#123456' });
  assert.equal(nodeColor(graph, a), '#ff8800');

  // …and reset goes back to the (current) category colour.
  updateNode(graph, a.id, { color: null });
  assert.equal(nodeColor(graph, a), '#123456');

  assert.throws(() => updateNode(graph, a.id, { color: 'red; background:url(x)' }), /Not a colour/);
});

test('node colour survives a round-trip and junk is dropped', () => {
  const { graph, a, b } = fixture();
  updateNode(graph, a.id, { color: '#abc' });
  const { graph: back } = deserialize(serialize(graph));
  assert.equal(getNode(back, a.id).color, '#abc');
  assert.equal(getNode(back, b.id).color, null);

  const dirty = normalizeGraph({ ...JSON.parse(serialize(graph)), nodes: [{ id: 'q', color: 'javascript:1' }] });
  assert.equal(dirty.nodes[0].color, null);
});
