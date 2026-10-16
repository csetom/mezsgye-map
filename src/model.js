/**
 * Mezsgye Atlas — core data model.
 *
 * Pure ESM with no Node or browser APIs, so the exact same file is imported by
 * the server (`import ... from './src/model.js'`) and by the browser
 * (`import ... from '/shared/model.js'`). All graph logic lives here; the server
 * only persists, the client only draws.
 *
 * Shape of a document:
 *
 *   {
 *     schemaVersion: 2,
 *     meta:   { title, subtitle, notes, created, modified },
 *     schema: { nodeCategories: [...], edgeCategories: [...] },
 *     nodes:  [ { id, name, category, x, y, pinned, parent, color, data, notes } ],
 *     edges:  [ { id, from, to, category, data, notes } ]
 *   }
 *
 * "Categories" are the expandable part: a category declares its own list of
 * custom fields, and users may add categories and fields at runtime. Nothing in
 * the renderer or the inspector is hard-coded to a specific category.
 */

/**
 * Document format version.
 *
 * 2 — edge "travel cost" and free-text "travel time" merged into one
 *     `cost` field of type `duration`, stored as hours.
 */
export const SCHEMA_VERSION = 2;

/**
 * Field types the inspector knows how to render. `duration` is stored as a
 * number of hours and shown as months / days / hours.
 */
export const FIELD_TYPES = ['text', 'textarea', 'number', 'duration', 'boolean', 'select', 'tags'];

/** Calendar used to turn travel hours into days and months. */
export const HOURS_PER_DAY = 24;
export const DAYS_PER_MONTH = 30;
export const HOURS_PER_MONTH = HOURS_PER_DAY * DAYS_PER_MONTH;

/** A colour value usable as a node override: `#rgb` or `#rrggbb`. */
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Glyphs a node category can be drawn with. */
export const NODE_SHAPES = ['hex', 'circle', 'square', 'triangle', 'diamond', 'star'];

/** Line styles an edge category can be drawn with. */
export const EDGE_STYLES = ['solid', 'dashed', 'dotted', 'double'];

const ID_PREFIX = { node: 'n', edge: 'e' };

/* ------------------------------------------------------------------ *
 * Small utilities
 * ------------------------------------------------------------------ */

/**
 * Deterministic 32-bit PRNG (mulberry32). Used so a given generator seed
 * always produces the same sector map.
 *
 * @param {number} seed
 * @returns {() => number} function yielding floats in [0, 1)
 */
export function makeRng(seed) {
  let a = (seed >>> 0) || 1;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pick a random member of an array using the supplied rng. */
export function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

/** Random integer in [min, max] inclusive. */
export function randInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

/** Structured deep clone that works in Node and the browser. */
export function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

/** Turn a label into a stable snake_case key usable as a category/field id. */
export function slugify(label, fallback = 'item') {
  const slug = String(label ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug || fallback;
}

/**
 * Allocate an id that is not yet taken.
 *
 * @param {string} prefix
 * @param {Set<string>|string[]} taken
 */
export function makeId(prefix, taken) {
  const used = taken instanceof Set ? taken : new Set(taken ?? []);
  let i = 1;
  let id = `${prefix}${i}`;
  while (used.has(id)) {
    i += 1;
    id = `${prefix}${i}`;
  }
  return id;
}

function nowIso() {
  return new Date().toISOString();
}

/* ------------------------------------------------------------------ *
 * Default schema — the Mezsgye setting out of the box
 * ------------------------------------------------------------------ */

/**
 * Build the default, setting-flavoured schema.
 *
 * Sectors are regions of the void; worlds live inside a sector (via `parent`);
 * waystations and anomalies decorate the map. Edges are essence streets and
 * their weaker or broken variants.
 *
 * @returns {object} a fresh schema object (safe to mutate)
 */
export function defaultSchema() {
  return {
    nodeCategories: [
      {
        id: 'sector',
        label: 'Sector',
        color: '#8b6cff',
        shape: 'hex',
        size: 26,
        description: 'A region of the void, bounded by the essence currents that reach it.',
        fields: [
          {
            key: 'essence_density',
            label: 'Essence density',
            type: 'select',
            options: ['dead', 'thin', 'stable', 'rich', 'volatile'],
            default: 'stable',
          },
          { key: 'ruling_power', label: 'Ruling power', type: 'text' },
          {
            key: 'access',
            label: 'Access',
            type: 'select',
            options: ['open', 'tolled', 'warded', 'forbidden', 'unknown'],
            default: 'open',
          },
          { key: 'toll', label: 'Toll / price of passage', type: 'text' },
          { key: 'hazards', label: 'Hazards', type: 'tags' },
          { key: 'discovered', label: 'Charted', type: 'boolean', default: true },
          { key: 'description', label: 'Description', type: 'textarea' },
        ],
      },
      {
        id: 'world',
        label: 'World',
        color: '#3fbfa8',
        shape: 'circle',
        size: 16,
        description: 'A world sitting inside a sector. Belongs to its parent sector.',
        fields: [
          {
            key: 'world_type',
            label: 'World type',
            type: 'select',
            options: ['terrestrial', 'oceanic', 'shard', 'city-world', 'wild', 'dead'],
            default: 'terrestrial',
          },
          {
            key: 'reachable_from',
            label: 'Reachable from',
            type: 'select',
            options: ['void-side', 'outside-only', 'both'],
            default: 'both',
          },
          {
            key: 'magic_level',
            label: 'Magic level',
            type: 'select',
            options: ['null', 'faint', 'common', 'saturated'],
            default: 'common',
          },
          { key: 'population', label: 'Population', type: 'text' },
          { key: 'factions', label: 'Factions', type: 'tags' },
          { key: 'hooks', label: 'Adventure hooks', type: 'textarea' },
        ],
      },
      {
        id: 'waystation',
        label: 'Waystation',
        color: '#d9a13b',
        shape: 'square',
        size: 15,
        description: 'A moored point on the streets where void makers rest, trade or refuel.',
        fields: [
          { key: 'operator', label: 'Operator', type: 'text' },
          { key: 'services', label: 'Services', type: 'tags' },
          {
            key: 'safety',
            label: 'Safety',
            type: 'select',
            options: ['sanctuary', 'neutral', 'rough', 'trap'],
            default: 'neutral',
          },
          { key: 'description', label: 'Description', type: 'textarea' },
        ],
      },
      {
        id: 'island',
        label: 'Island',
        color: '#61afef',
        shape: 'diamond',
        size: 20,
        description: 'A place in the void with its own ecosystem',
        fields: [
          {
            key: 'safety',
            label: 'Safety',
            type: 'select',
            options: ['sanctuary', 'neutral', 'rough', 'trap'],
            default: 'neutral',
          },
          {
            key: 'danger',
            label: 'Danger',
            type: 'select',
            options: ['low', 'moderate', 'severe', 'lethal'],
            default: 'moderate',
          },
          {
            key: 'magic_level',
            label: 'Magic level',
            type: 'select',
            options: ['null', 'faint', 'common', 'saturated'],
            default: 'common',
          },
          { key: 'population', label: 'Population', type: 'text' },
          { key: 'factions', label: 'Factions', type: 'tags' },
          { key: 'services', label: 'Services', type: 'tags' },
          { key: 'description', label: 'Description', type: 'textarea' },
        ],
      },
      {
        id: 'anomaly',
        label: 'Anomaly',
        color: '#e0575b',
        shape: 'triangle',
        size: 15,
        description: 'Something in the essence that should not be there.',
        fields: [
          { key: 'phenomenon', label: 'Phenomenon', type: 'text' },
          {
            key: 'danger',
            label: 'Danger',
            type: 'select',
            options: ['low', 'moderate', 'severe', 'lethal'],
            default: 'moderate',
          },
          { key: 'effect', label: 'Effect on travellers', type: 'textarea' },
        ],
      },
    ],
    edgeCategories: [
      {
        id: 'essence_street',
        label: 'Essence street',
        color: '#8b6cff',
        style: 'solid',
        width: 3.5,
        description: 'A major essence wave used as a highway between sectors.',
        fields: [
          {
            key: 'cost',
            label: 'Travel time',
            type: 'duration',
            default: 24,
            help: 'Used by the Route tool. e.g. 36h, 2d 6h, 1 month.',
          },
          {
            key: 'current_strength',
            label: 'Current strength',
            type: 'select',
            options: ['sluggish', 'steady', 'swift', 'torrential'],
            default: 'steady',
          },
          { key: 'toll', label: 'Toll', type: 'text' },
          { key: 'void_maker_required', label: 'Void maker required', type: 'boolean', default: true },
          { key: 'hazards', label: 'Hazards', type: 'tags' },
          { key: 'description', label: 'Description', type: 'textarea' },
        ],
      },
      {
        id: 'minor_current',
        label: 'Minor current',
        color: '#5b84c4',
        style: 'dashed',
        width: 2,
        description: 'A thin, unreliable wave. Slower, cheaper, less watched.',
        fields: [
          {
            key: 'cost',
            label: 'Travel time',
            type: 'duration',
            default: 72,
            help: 'Used by the Route tool. e.g. 36h, 2d 6h, 1 month.',
          },
          {
            key: 'stability',
            label: 'Stability',
            type: 'select',
            options: ['fraying', 'intermittent', 'reliable'],
            default: 'intermittent',
          },
          { key: 'description', label: 'Description', type: 'textarea' },
        ],
      },
      {
        id: 'collapsed_route',
        label: 'Collapsed route',
        color: '#6d6d7a',
        style: 'dotted',
        width: 2,
        description: 'A street that no longer carries. Known, mapped, unusable.',
        fields: [
          { key: 'collapsed_when', label: 'Collapsed when', type: 'text' },
          { key: 'cause', label: 'Cause', type: 'textarea' },
        ],
      },
    ],
  };
}

/* ------------------------------------------------------------------ *
 * Construction / normalisation
 * ------------------------------------------------------------------ */

/**
 * Create an empty atlas document.
 *
 * @param {{title?: string, subtitle?: string, schema?: object}} [opts]
 * @returns {object} graph document
 */
export function createEmptyGraph(opts = {}) {
  const ts = nowIso();
  return {
    schemaVersion: SCHEMA_VERSION,
    meta: {
      title: opts.title ?? 'Untitled Atlas',
      subtitle: opts.subtitle ?? '',
      notes: '',
      created: ts,
      modified: ts,
    },
    schema: opts.schema ? clone(opts.schema) : defaultSchema(),
    nodes: [],
    edges: [],
  };
}

function normalizeField(field) {
  const type = FIELD_TYPES.includes(field?.type) ? field.type : 'text';
  const out = {
    key: slugify(field?.key ?? field?.label, 'field'),
    label: String(field?.label ?? field?.key ?? 'Field'),
    type,
  };
  if (type === 'select') {
    out.options = Array.isArray(field?.options) ? field.options.map(String) : [];
  }
  if (field?.default !== undefined) out.default = field.default;
  if (field?.help) out.help = String(field.help);
  return out;
}

function normalizeNodeCategory(cat, index) {
  return {
    id: slugify(cat?.id ?? cat?.label, `category_${index + 1}`),
    label: String(cat?.label ?? cat?.id ?? `Category ${index + 1}`),
    color: typeof cat?.color === 'string' ? cat.color : '#8b6cff',
    shape: NODE_SHAPES.includes(cat?.shape) ? cat.shape : 'circle',
    size: Number.isFinite(cat?.size) ? cat.size : 18,
    description: String(cat?.description ?? ''),
    fields: Array.isArray(cat?.fields) ? cat.fields.map(normalizeField) : [],
  };
}

function normalizeEdgeCategory(cat, index) {
  return {
    id: slugify(cat?.id ?? cat?.label, `link_${index + 1}`),
    label: String(cat?.label ?? cat?.id ?? `Link ${index + 1}`),
    color: typeof cat?.color === 'string' ? cat.color : '#8b6cff',
    style: EDGE_STYLES.includes(cat?.style) ? cat.style : 'solid',
    width: Number.isFinite(cat?.width) ? cat.width : 2.5,
    description: String(cat?.description ?? ''),
    fields: Array.isArray(cat?.fields) ? cat.fields.map(normalizeField) : [],
  };
}

/**
 * Coerce an arbitrary parsed object into a well-formed atlas document.
 *
 * Unknown keys are dropped, missing keys filled with defaults, dangling edges
 * and parent references removed. Always returns a new object; never throws on
 * structurally odd input (use {@link validateGraph} first if you want to know
 * what was wrong).
 *
 * @param {any} input
 * @returns {object} normalized graph
 */
export function normalizeGraph(input) {
  const src = input && typeof input === 'object' ? input : {};
  const base = createEmptyGraph();

  const schemaSrc = src.schema && typeof src.schema === 'object' ? src.schema : {};
  const nodeCategories = Array.isArray(schemaSrc.nodeCategories) && schemaSrc.nodeCategories.length
    ? schemaSrc.nodeCategories.map(normalizeNodeCategory)
    : base.schema.nodeCategories;
  const edgeCategories = Array.isArray(schemaSrc.edgeCategories) && schemaSrc.edgeCategories.length
    ? schemaSrc.edgeCategories.map(normalizeEdgeCategory)
    : base.schema.edgeCategories;

  const nodeCatIds = new Set(nodeCategories.map((c) => c.id));
  const edgeCatIds = new Set(edgeCategories.map((c) => c.id));
  const fallbackNodeCat = nodeCategories[0].id;
  const fallbackEdgeCat = edgeCategories[0].id;

  const seenNodeIds = new Set();
  const nodes = (Array.isArray(src.nodes) ? src.nodes : []).map((raw, i) => {
    let id = typeof raw?.id === 'string' && raw.id ? raw.id : makeId(ID_PREFIX.node, seenNodeIds);
    if (seenNodeIds.has(id)) id = makeId(ID_PREFIX.node, seenNodeIds);
    seenNodeIds.add(id);
    const category = nodeCatIds.has(raw?.category) ? raw.category : fallbackNodeCat;
    return {
      id,
      name: String(raw?.name ?? `Node ${i + 1}`),
      category,
      x: Number.isFinite(raw?.x) ? raw.x : 0,
      y: Number.isFinite(raw?.y) ? raw.y : 0,
      pinned: Boolean(raw?.pinned),
      parent: typeof raw?.parent === 'string' && raw.parent ? raw.parent : null,
      color: normalizeColor(raw?.color),
      data: raw?.data && typeof raw.data === 'object' ? { ...raw.data } : {},
      notes: String(raw?.notes ?? ''),
    };
  });

  // Drop parent references that point nowhere or at the node itself.
  for (const node of nodes) {
    if (node.parent && (!seenNodeIds.has(node.parent) || node.parent === node.id)) {
      node.parent = null;
    }
  }
  breakParentCycles(nodes);

  const seenEdgeIds = new Set();
  const edges = [];
  for (const raw of Array.isArray(src.edges) ? src.edges : []) {
    const from = raw?.from;
    const to = raw?.to;
    if (!seenNodeIds.has(from) || !seenNodeIds.has(to) || from === to) continue;
    let id = typeof raw?.id === 'string' && raw.id ? raw.id : makeId(ID_PREFIX.edge, seenEdgeIds);
    if (seenEdgeIds.has(id)) id = makeId(ID_PREFIX.edge, seenEdgeIds);
    seenEdgeIds.add(id);
    edges.push({
      id,
      from,
      to,
      category: edgeCatIds.has(raw?.category) ? raw.category : fallbackEdgeCat,
      data: raw?.data && typeof raw.data === 'object' ? { ...raw.data } : {},
      notes: String(raw?.notes ?? ''),
    });
  }

  const sourceVersion = Number.isFinite(src.schemaVersion) ? src.schemaVersion : 1;
  if (sourceVersion < 2) migrateTravelTime(edgeCategories, edges);

  const metaSrc = src.meta && typeof src.meta === 'object' ? src.meta : {};
  return {
    schemaVersion: SCHEMA_VERSION,
    meta: {
      title: String(metaSrc.title ?? base.meta.title),
      subtitle: String(metaSrc.subtitle ?? ''),
      notes: String(metaSrc.notes ?? ''),
      created: String(metaSrc.created ?? base.meta.created),
      modified: String(metaSrc.modified ?? base.meta.modified),
    },
    schema: { nodeCategories, edgeCategories },
    nodes,
    edges,
  };
}

/** A valid `#rgb`/`#rrggbb` override, or null meaning "use the category colour". */
function normalizeColor(value) {
  return typeof value === 'string' && HEX_COLOR.test(value.trim()) ? value.trim().toLowerCase() : null;
}

/**
 * v1 → v2: merge the numeric "travel cost" and free-text "travel time" edge
 * fields into one `cost` field of type `duration` (hours).
 *
 * A parseable `travel_time` ("5 days") wins and becomes the hour count; when
 * it is missing or unreadable the old `cost` number is kept and read as hours.
 * Unreadable text is preserved in the edge's description rather than lost.
 * Mutates the (already normalized, freshly built) arrays in place.
 */
function migrateTravelTime(edgeCategories, edges) {
  const touched = new Set();
  for (const cat of edgeCategories) {
    const costField = cat.fields.find((f) => f.key === 'cost');
    const timeIndex = cat.fields.findIndex((f) => f.key === 'travel_time');
    if (!costField && timeIndex === -1) continue;
    touched.add(cat.id);
    if (costField) {
      costField.type = 'duration';
      if (/^travel cost$|^cost$/i.test(costField.label)) costField.label = 'Travel time';
      const def = parseDuration(costField.default);
      if (def === null) delete costField.default;
      else costField.default = def;
    } else {
      cat.fields.splice(timeIndex, 0, { key: 'cost', label: 'Travel time', type: 'duration' });
    }
    const stale = cat.fields.findIndex((f) => f.key === 'travel_time');
    if (stale !== -1) cat.fields.splice(stale, 1);
  }

  for (const edge of edges) {
    if (!touched.has(edge.category) && edge.data.travel_time === undefined) continue;
    const text = edge.data.travel_time;
    const fromText = parseDuration(text);
    if (fromText !== null) {
      edge.data.cost = fromText;
    } else {
      const old = Number(edge.data.cost);
      if (Number.isFinite(old) && old >= 0) edge.data.cost = old;
      else delete edge.data.cost;
      if (typeof text === 'string' && text.trim()) {
        const note = `Travel time (old): ${text.trim()}`;
        edge.data.description = edge.data.description ? `${edge.data.description}\n${note}` : note;
      }
    }
    delete edge.data.travel_time;
  }
}

/** Walk parent chains and cut any that loop. */
function breakParentCycles(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const node of nodes) {
    const seen = new Set([node.id]);
    let cur = node;
    while (cur.parent) {
      if (seen.has(cur.parent)) {
        cur.parent = null;
        break;
      }
      seen.add(cur.parent);
      cur = byId.get(cur.parent);
      if (!cur) break;
    }
  }
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

/**
 * Check a document without modifying it.
 *
 * @param {any} graph
 * @returns {{ok: boolean, errors: string[], warnings: string[]}}
 */
export function validateGraph(graph) {
  const errors = [];
  const warnings = [];

  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) {
    return { ok: false, errors: ['Document is not an object.'], warnings };
  }
  if (!Array.isArray(graph.nodes)) errors.push('`nodes` must be an array.');
  if (!Array.isArray(graph.edges)) errors.push('`edges` must be an array.');
  if (!graph.schema || typeof graph.schema !== 'object') {
    errors.push('`schema` must be an object.');
  } else {
    if (!Array.isArray(graph.schema.nodeCategories) || graph.schema.nodeCategories.length === 0) {
      errors.push('`schema.nodeCategories` must be a non-empty array.');
    }
    if (!Array.isArray(graph.schema.edgeCategories) || graph.schema.edgeCategories.length === 0) {
      errors.push('`schema.edgeCategories` must be a non-empty array.');
    }
  }
  if (errors.length) return { ok: false, errors, warnings };

  if (graph.schemaVersion !== SCHEMA_VERSION) {
    warnings.push(
      `Document schemaVersion is ${graph.schemaVersion ?? 'missing'}; expected ${SCHEMA_VERSION}. It will be migrated on load.`,
    );
  }

  const nodeCatIds = new Set(graph.schema.nodeCategories.map((c) => c?.id));
  const edgeCatIds = new Set(graph.schema.edgeCategories.map((c) => c?.id));
  const nodeIds = new Set();

  for (const [i, node] of graph.nodes.entries()) {
    const where = `nodes[${i}]`;
    if (!node || typeof node !== 'object') {
      errors.push(`${where} is not an object.`);
      continue;
    }
    if (typeof node.id !== 'string' || !node.id) errors.push(`${where}.id is missing.`);
    else if (nodeIds.has(node.id)) errors.push(`${where}.id "${node.id}" is duplicated.`);
    else nodeIds.add(node.id);
    if (!nodeCatIds.has(node.category)) {
      warnings.push(`${where} has unknown category "${node.category}".`);
    }
  }

  for (const [i, node] of graph.nodes.entries()) {
    if (node?.parent && !nodeIds.has(node.parent)) {
      warnings.push(`nodes[${i}] has a dangling parent "${node.parent}".`);
    }
  }

  const edgeIds = new Set();
  for (const [i, edge] of graph.edges.entries()) {
    const where = `edges[${i}]`;
    if (!edge || typeof edge !== 'object') {
      errors.push(`${where} is not an object.`);
      continue;
    }
    if (typeof edge.id !== 'string' || !edge.id) errors.push(`${where}.id is missing.`);
    else if (edgeIds.has(edge.id)) errors.push(`${where}.id "${edge.id}" is duplicated.`);
    else edgeIds.add(edge.id);
    if (!nodeIds.has(edge.from)) errors.push(`${where}.from "${edge.from}" is not a known node.`);
    if (!nodeIds.has(edge.to)) errors.push(`${where}.to "${edge.to}" is not a known node.`);
    if (edge.from === edge.to) warnings.push(`${where} is a self-link and will be dropped.`);
    if (!edgeCatIds.has(edge.category)) {
      warnings.push(`${where} has unknown category "${edge.category}".`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/* ------------------------------------------------------------------ *
 * Lookups
 * ------------------------------------------------------------------ */

export function getNode(graph, id) {
  return graph.nodes.find((n) => n.id === id) ?? null;
}

export function getEdge(graph, id) {
  return graph.edges.find((e) => e.id === id) ?? null;
}

export function getNodeCategory(graph, id) {
  return graph.schema.nodeCategories.find((c) => c.id === id) ?? null;
}

export function getEdgeCategory(graph, id) {
  return graph.schema.edgeCategories.find((c) => c.id === id) ?? null;
}

/** The colour a node is drawn with: its own override, else its category's. */
export function nodeColor(graph, node) {
  return node?.color || getNodeCategory(graph, node?.category)?.color || '#8b6cff';
}

/** Direct children of a node (e.g. the worlds of a sector). */
export function childrenOf(graph, nodeId) {
  return graph.nodes.filter((n) => n.parent === nodeId);
}

/** All edges touching a node. */
export function edgesOf(graph, nodeId) {
  return graph.edges.filter((e) => e.from === nodeId || e.to === nodeId);
}

/** Edges touching a node, paired with the node at the far end. */
export function neighborsOf(graph, nodeId) {
  return edgesOf(graph, nodeId).map((edge) => ({
    edge,
    node: getNode(graph, edge.from === nodeId ? edge.to : edge.from),
  }));
}

/** Build the `data` object for a category from its field defaults. */
export function defaultsFor(category) {
  const data = {};
  for (const field of category?.fields ?? []) {
    if (field.default !== undefined) {
      data[field.key] = field.default;
    } else if (field.type === 'tags') {
      data[field.key] = [];
    } else if (field.type === 'boolean') {
      data[field.key] = false;
    }
  }
  return data;
}

function touch(graph) {
  graph.meta.modified = nowIso();
}

/* ------------------------------------------------------------------ *
 * Node / edge mutation
 * ------------------------------------------------------------------ */

/**
 * Add a node. Mutates `graph` and returns the created node.
 *
 * @param {object} graph
 * @param {{name?: string, category?: string, x?: number, y?: number,
 *          parent?: string|null, data?: object, notes?: string,
 *          pinned?: boolean, id?: string}} [spec]
 */
export function addNode(graph, spec = {}) {
  const category = getNodeCategory(graph, spec.category) ?? graph.schema.nodeCategories[0];
  const taken = new Set(graph.nodes.map((n) => n.id));
  const id = spec.id && !taken.has(spec.id) ? spec.id : makeId(ID_PREFIX.node, taken);
  const node = {
    id,
    name: spec.name ?? `New ${category.label}`,
    category: category.id,
    x: Number.isFinite(spec.x) ? spec.x : 0,
    y: Number.isFinite(spec.y) ? spec.y : 0,
    pinned: Boolean(spec.pinned),
    parent: spec.parent && getNode(graph, spec.parent) ? spec.parent : null,
    color: normalizeColor(spec.color),
    data: { ...defaultsFor(category), ...(spec.data ?? {}) },
    notes: spec.notes ?? '',
  };
  graph.nodes.push(node);
  touch(graph);
  return node;
}

/**
 * Patch a node in place. Changing `category` re-seeds missing field defaults
 * but keeps any values whose keys the new category also declares.
 *
 * @returns {object} the updated node
 */
export function updateNode(graph, id, patch = {}) {
  const node = getNode(graph, id);
  if (!node) throw new Error(`No such node: ${id}`);

  if (patch.category && patch.category !== node.category) {
    const next = getNodeCategory(graph, patch.category);
    if (!next) throw new Error(`No such node category: ${patch.category}`);
    const keep = {};
    for (const field of next.fields) {
      if (node.data[field.key] !== undefined) keep[field.key] = node.data[field.key];
    }
    node.category = next.id;
    node.data = { ...defaultsFor(next), ...keep };
  }

  if (patch.name !== undefined) node.name = String(patch.name);
  if (patch.notes !== undefined) node.notes = String(patch.notes);
  if (patch.x !== undefined && Number.isFinite(patch.x)) node.x = patch.x;
  if (patch.y !== undefined && Number.isFinite(patch.y)) node.y = patch.y;
  if (patch.pinned !== undefined) node.pinned = Boolean(patch.pinned);
  if (patch.color !== undefined) {
    // null / '' resets to the category colour.
    if (patch.color === null || patch.color === '') node.color = null;
    else {
      const color = normalizeColor(patch.color);
      if (!color) throw new Error(`Not a colour: ${patch.color}`);
      node.color = color;
    }
  }
  if (patch.parent !== undefined) {
    if (patch.parent === null || patch.parent === '') {
      node.parent = null;
    } else if (patch.parent === id) {
      throw new Error('A node cannot be its own parent.');
    } else if (!getNode(graph, patch.parent)) {
      throw new Error(`No such node: ${patch.parent}`);
    } else if (isDescendant(graph, patch.parent, id)) {
      throw new Error('That would create a containment cycle.');
    } else {
      node.parent = patch.parent;
    }
  }
  if (patch.data !== undefined) node.data = { ...node.data, ...patch.data };

  touch(graph);
  return node;
}

/** True if `candidateId` sits anywhere beneath `ancestorId`. */
export function isDescendant(graph, candidateId, ancestorId) {
  let cur = getNode(graph, candidateId);
  const guard = new Set();
  while (cur?.parent) {
    if (cur.parent === ancestorId) return true;
    if (guard.has(cur.parent)) return false;
    guard.add(cur.parent);
    cur = getNode(graph, cur.parent);
  }
  return false;
}

/**
 * Delete a node, its incident edges, and (recursively) its children.
 *
 * @returns {{nodes: string[], edges: string[]}} ids that were removed
 */
export function removeNode(graph, id) {
  const target = getNode(graph, id);
  if (!target) return { nodes: [], edges: [] };

  const doomed = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const node of graph.nodes) {
      if (node.parent && doomed.has(node.parent) && !doomed.has(node.id)) {
        doomed.add(node.id);
        grew = true;
      }
    }
  }

  const removedEdges = graph.edges
    .filter((e) => doomed.has(e.from) || doomed.has(e.to))
    .map((e) => e.id);
  graph.edges = graph.edges.filter((e) => !doomed.has(e.from) && !doomed.has(e.to));
  graph.nodes = graph.nodes.filter((n) => !doomed.has(n.id));
  touch(graph);
  return { nodes: [...doomed], edges: removedEdges };
}

/**
 * Add an edge between two existing nodes.
 *
 * @param {object} graph
 * @param {{from: string, to: string, category?: string, data?: object,
 *          notes?: string, id?: string}} spec
 */
export function addEdge(graph, spec = {}) {
  const from = getNode(graph, spec.from);
  const to = getNode(graph, spec.to);
  if (!from) throw new Error(`No such node: ${spec.from}`);
  if (!to) throw new Error(`No such node: ${spec.to}`);
  if (from.id === to.id) throw new Error('A highway cannot loop back to its own sector.');

  const category = getEdgeCategory(graph, spec.category) ?? graph.schema.edgeCategories[0];
  const taken = new Set(graph.edges.map((e) => e.id));
  const id = spec.id && !taken.has(spec.id) ? spec.id : makeId(ID_PREFIX.edge, taken);
  const edge = {
    id,
    from: from.id,
    to: to.id,
    category: category.id,
    data: { ...defaultsFor(category), ...(spec.data ?? {}) },
    notes: spec.notes ?? '',
  };
  graph.edges.push(edge);
  touch(graph);
  return edge;
}

/** Patch an edge in place, with the same category-change semantics as nodes. */
export function updateEdge(graph, id, patch = {}) {
  const edge = getEdge(graph, id);
  if (!edge) throw new Error(`No such edge: ${id}`);

  if (patch.category && patch.category !== edge.category) {
    const next = getEdgeCategory(graph, patch.category);
    if (!next) throw new Error(`No such edge category: ${patch.category}`);
    const keep = {};
    for (const field of next.fields) {
      if (edge.data[field.key] !== undefined) keep[field.key] = edge.data[field.key];
    }
    edge.category = next.id;
    edge.data = { ...defaultsFor(next), ...keep };
  }

  if (patch.notes !== undefined) edge.notes = String(patch.notes);
  if (patch.from !== undefined) {
    if (!getNode(graph, patch.from)) throw new Error(`No such node: ${patch.from}`);
    edge.from = patch.from;
  }
  if (patch.to !== undefined) {
    if (!getNode(graph, patch.to)) throw new Error(`No such node: ${patch.to}`);
    edge.to = patch.to;
  }
  if (edge.from === edge.to) throw new Error('A highway cannot loop back to its own sector.');
  if (patch.data !== undefined) edge.data = { ...edge.data, ...patch.data };

  touch(graph);
  return edge;
}

/** Remove an edge. Returns true if something was removed. */
export function removeEdge(graph, id) {
  const before = graph.edges.length;
  graph.edges = graph.edges.filter((e) => e.id !== id);
  const removed = graph.edges.length !== before;
  if (removed) touch(graph);
  return removed;
}

/* ------------------------------------------------------------------ *
 * Schema mutation — this is what makes the categories expandable
 * ------------------------------------------------------------------ */

function addCategory(list, spec, normalize, kindLabel) {
  const id = slugify(spec?.id ?? spec?.label, `${kindLabel}_${list.length + 1}`);
  if (list.some((c) => c.id === id)) {
    throw new Error(`A ${kindLabel} category with id "${id}" already exists.`);
  }
  const cat = normalize({ ...spec, id }, list.length);
  list.push(cat);
  return cat;
}

/** Register a new node category. Returns the stored category. */
export function addNodeCategory(graph, spec = {}) {
  const cat = addCategory(graph.schema.nodeCategories, spec, normalizeNodeCategory, 'node');
  touch(graph);
  return cat;
}

/** Register a new edge category. Returns the stored category. */
export function addEdgeCategory(graph, spec = {}) {
  const cat = addCategory(graph.schema.edgeCategories, spec, normalizeEdgeCategory, 'link');
  touch(graph);
  return cat;
}

/** Patch a category's presentation (label, colour, shape/style, size/width). */
export function updateCategory(graph, kind, id, patch = {}) {
  const list = kind === 'node' ? graph.schema.nodeCategories : graph.schema.edgeCategories;
  const cat = list.find((c) => c.id === id);
  if (!cat) throw new Error(`No such ${kind} category: ${id}`);
  if (patch.label !== undefined) cat.label = String(patch.label);
  if (patch.color !== undefined) cat.color = String(patch.color);
  if (patch.description !== undefined) cat.description = String(patch.description);
  if (kind === 'node') {
    if (patch.shape !== undefined && NODE_SHAPES.includes(patch.shape)) cat.shape = patch.shape;
    if (patch.size !== undefined && Number.isFinite(patch.size)) cat.size = patch.size;
  } else {
    if (patch.style !== undefined && EDGE_STYLES.includes(patch.style)) cat.style = patch.style;
    if (patch.width !== undefined && Number.isFinite(patch.width)) cat.width = patch.width;
  }
  touch(graph);
  return cat;
}

/** How many nodes/edges currently use a category. */
export function countUsage(graph, kind, id) {
  return kind === 'node'
    ? graph.nodes.filter((n) => n.category === id).length
    : graph.edges.filter((e) => e.category === id).length;
}

/**
 * Remove a category. Refuses if it is in use unless `reassignTo` names another
 * category to move the affected items to. Refuses to remove the last one.
 */
export function removeCategory(graph, kind, id, reassignTo = null) {
  const list = kind === 'node' ? graph.schema.nodeCategories : graph.schema.edgeCategories;
  const cat = list.find((c) => c.id === id);
  if (!cat) throw new Error(`No such ${kind} category: ${id}`);
  if (list.length === 1) throw new Error(`Cannot remove the last ${kind} category.`);

  const inUse = countUsage(graph, kind, id);
  if (inUse > 0) {
    if (!reassignTo) {
      throw new Error(
        `Category "${cat.label}" is used by ${inUse} item(s). Choose a category to reassign them to.`,
      );
    }
    if (!list.some((c) => c.id === reassignTo)) {
      throw new Error(`No such ${kind} category: ${reassignTo}`);
    }
    const items = kind === 'node' ? graph.nodes : graph.edges;
    for (const item of items) {
      if (item.category === id) {
        if (kind === 'node') updateNode(graph, item.id, { category: reassignTo });
        else updateEdge(graph, item.id, { category: reassignTo });
      }
    }
  }

  const idx = list.findIndex((c) => c.id === id);
  list.splice(idx, 1);
  touch(graph);
  return true;
}

/**
 * Add a custom field to a category and back-fill its default onto every
 * existing item of that category.
 */
export function addField(graph, kind, categoryId, fieldSpec = {}) {
  const list = kind === 'node' ? graph.schema.nodeCategories : graph.schema.edgeCategories;
  const cat = list.find((c) => c.id === categoryId);
  if (!cat) throw new Error(`No such ${kind} category: ${categoryId}`);

  const field = normalizeField(fieldSpec);
  if (cat.fields.some((f) => f.key === field.key)) {
    throw new Error(`Field "${field.key}" already exists on ${cat.label}.`);
  }
  if (field.type === 'select' && field.options.length === 0) {
    throw new Error('A select field needs at least one option.');
  }
  cat.fields.push(field);

  const items = kind === 'node' ? graph.nodes : graph.edges;
  const seed = defaultsFor({ fields: [field] });
  for (const item of items) {
    if (item.category === categoryId && item.data[field.key] === undefined) {
      if (seed[field.key] !== undefined) item.data[field.key] = seed[field.key];
    }
  }
  touch(graph);
  return field;
}

/** Patch a field definition. Renaming the key migrates stored values. */
export function updateField(graph, kind, categoryId, fieldKey, patch = {}) {
  const list = kind === 'node' ? graph.schema.nodeCategories : graph.schema.edgeCategories;
  const cat = list.find((c) => c.id === categoryId);
  if (!cat) throw new Error(`No such ${kind} category: ${categoryId}`);
  const field = cat.fields.find((f) => f.key === fieldKey);
  if (!field) throw new Error(`No such field: ${fieldKey}`);

  const items = kind === 'node' ? graph.nodes : graph.edges;

  if (patch.key !== undefined) {
    const nextKey = slugify(patch.key, fieldKey);
    if (nextKey !== fieldKey) {
      if (cat.fields.some((f) => f.key === nextKey)) {
        throw new Error(`Field "${nextKey}" already exists on ${cat.label}.`);
      }
      for (const item of items) {
        if (item.category === categoryId && item.data[fieldKey] !== undefined) {
          item.data[nextKey] = item.data[fieldKey];
          delete item.data[fieldKey];
        }
      }
      field.key = nextKey;
    }
  }
  if (patch.label !== undefined) field.label = String(patch.label);
  if (patch.help !== undefined) field.help = String(patch.help);
  if (patch.type !== undefined && FIELD_TYPES.includes(patch.type)) {
    field.type = patch.type;
    if (field.type === 'select' && !Array.isArray(field.options)) field.options = [];
    if (field.type !== 'select') delete field.options;
  }
  if (patch.options !== undefined && field.type === 'select') {
    field.options = patch.options.map(String);
  }
  if (patch.default !== undefined) field.default = patch.default;
  touch(graph);
  return field;
}

/** Remove a field definition and, optionally, the stored values with it. */
export function removeField(graph, kind, categoryId, fieldKey, { purgeValues = true } = {}) {
  const list = kind === 'node' ? graph.schema.nodeCategories : graph.schema.edgeCategories;
  const cat = list.find((c) => c.id === categoryId);
  if (!cat) throw new Error(`No such ${kind} category: ${categoryId}`);
  const idx = cat.fields.findIndex((f) => f.key === fieldKey);
  if (idx === -1) throw new Error(`No such field: ${fieldKey}`);
  cat.fields.splice(idx, 1);
  if (purgeValues) {
    const items = kind === 'node' ? graph.nodes : graph.edges;
    for (const item of items) {
      if (item.category === categoryId) delete item.data[fieldKey];
    }
  }
  touch(graph);
  return true;
}

/* ------------------------------------------------------------------ *
 * Analysis
 * ------------------------------------------------------------------ */

/** Travel time of an edge in hours (the Route tool's weight), defaulting to 1. */
export function edgeCost(edge) {
  const raw = Number(edge?.data?.cost);
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

/** Unit words accepted by {@link parseDuration}, mapped to hours. English and Hungarian. */
const DURATION_UNITS = [
  [/^(h|hr|hrs|hour|hours|ó|óra|órá|órát)$/, 1],
  [/^(d|day|days|nap|napot)$/, HOURS_PER_DAY],
  [/^(w|wk|week|weeks|hét|hetet)$/, HOURS_PER_DAY * 7],
  [/^(mo|mon|month|months|hó|hónap|hónapot)$/, HOURS_PER_MONTH],
];

/**
 * Parse a human travel time into hours.
 *
 * Accepts a bare number (hours), or any mix of amounts and units:
 * "36", "36h", "2d 6h", "1 month 3 days", "1,5 nap", "2 hét".
 * A month is {@link DAYS_PER_MONTH} days, a day {@link HOURS_PER_DAY} hours.
 *
 * @param {string|number|null|undefined} input
 * @returns {number|null} hours, or null if the text is empty or not understood
 */
export function parseDuration(input) {
  if (typeof input === 'number') return Number.isFinite(input) && input >= 0 ? input : null;
  const text = String(input ?? '').trim().toLowerCase();
  if (!text) return null;
  if (/^\d+(?:[.,]\d+)?$/.test(text)) return Number(text.replace(',', '.'));

  const token = /(\d+(?:[.,]\d+)?)\s*([a-zá-ű]+)\.?/gy;
  const separator = /[\s,;+]*(?:and\s+|és\s+)?/y;
  let total = 0;
  let pos = 0;
  let matched = false;
  while (pos < text.length) {
    separator.lastIndex = pos;
    separator.exec(text);
    pos = separator.lastIndex;
    if (pos >= text.length) break;
    token.lastIndex = pos;
    const m = token.exec(text);
    if (!m) return null;
    const unit = DURATION_UNITS.find(([re]) => re.test(m[2]));
    if (!unit) return null;
    total += Number(m[1].replace(',', '.')) * unit[1];
    pos = token.lastIndex;
    matched = true;
  }
  return matched ? Math.round(total * 100) / 100 : null;
}

/**
 * Format hours as months / days / hours.
 *
 * @param {number|null|undefined} hours
 * @param {{compact?: boolean}} [opts] compact gives "1mo 2d 6h"
 * @returns {string} e.g. "1 month 2 days 6 hours"; '' for missing values
 */
export function formatDuration(hours, { compact = false } = {}) {
  const value = Number(hours);
  if (hours === null || hours === undefined || hours === '' || !Number.isFinite(value) || value < 0) return '';
  let rest = Math.round(value * 10) / 10;
  const months = Math.floor(rest / HOURS_PER_MONTH);
  rest -= months * HOURS_PER_MONTH;
  const days = Math.floor(rest / HOURS_PER_DAY);
  rest = Math.round((rest - days * HOURS_PER_DAY) * 10) / 10;

  const parts = [];
  const add = (n, short, one, many) => {
    if (n) parts.push(compact ? `${n}${short}` : `${n} ${n === 1 ? one : many}`);
  };
  add(months, 'mo', 'month', 'months');
  add(days, 'd', 'day', 'days');
  add(rest, 'h', 'hour', 'hours');
  if (!parts.length) return compact ? '0h' : '0 hours';
  return parts.join(' ');
}

/**
 * Cheapest route between two nodes (Dijkstra over `cost`).
 *
 * @param {object} graph
 * @param {string} fromId
 * @param {string} toId
 * @param {{exclude?: string[]}} [opts] edge category ids to treat as impassable
 * @returns {{nodes: string[], edges: string[], cost: number}|null}
 */
export function findRoute(graph, fromId, toId, opts = {}) {
  if (!getNode(graph, fromId) || !getNode(graph, toId)) return null;
  if (fromId === toId) return { nodes: [fromId], edges: [], cost: 0 };

  const blocked = new Set(opts.exclude ?? []);
  const adjacency = new Map();
  for (const node of graph.nodes) adjacency.set(node.id, []);
  for (const edge of graph.edges) {
    if (blocked.has(edge.category)) continue;
    adjacency.get(edge.from)?.push({ to: edge.to, edge });
    adjacency.get(edge.to)?.push({ to: edge.from, edge });
  }

  const dist = new Map([[fromId, 0]]);
  const prev = new Map();
  const visited = new Set();
  const queue = new Set([fromId]);

  while (queue.size) {
    let current = null;
    let best = Infinity;
    for (const id of queue) {
      const d = dist.get(id) ?? Infinity;
      if (d < best) {
        best = d;
        current = id;
      }
    }
    if (current === null) break;
    queue.delete(current);
    visited.add(current);
    if (current === toId) break;

    for (const { to, edge } of adjacency.get(current) ?? []) {
      if (visited.has(to)) continue;
      const next = best + edgeCost(edge);
      if (next < (dist.get(to) ?? Infinity)) {
        dist.set(to, next);
        prev.set(to, { node: current, edge: edge.id });
        queue.add(to);
      }
    }
  }

  if (!dist.has(toId)) return null;
  const nodes = [toId];
  const edges = [];
  let cursor = toId;
  while (prev.has(cursor)) {
    const step = prev.get(cursor);
    edges.unshift(step.edge);
    nodes.unshift(step.node);
    cursor = step.node;
  }
  return { nodes, edges, cost: dist.get(toId) };
}

/** Connected components over all edges, as arrays of node ids. */
export function components(graph) {
  const adjacency = new Map(graph.nodes.map((n) => [n.id, []]));
  for (const edge of graph.edges) {
    adjacency.get(edge.from)?.push(edge.to);
    adjacency.get(edge.to)?.push(edge.from);
  }
  const seen = new Set();
  const out = [];
  for (const node of graph.nodes) {
    if (seen.has(node.id)) continue;
    const stack = [node.id];
    const group = [];
    seen.add(node.id);
    while (stack.length) {
      const id = stack.pop();
      group.push(id);
      for (const next of adjacency.get(id) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    out.push(group);
  }
  return out;
}

/** Headline numbers for the status bar. */
export function graphStats(graph) {
  const byNodeCategory = {};
  for (const cat of graph.schema.nodeCategories) byNodeCategory[cat.id] = 0;
  for (const node of graph.nodes) {
    byNodeCategory[node.category] = (byNodeCategory[node.category] ?? 0) + 1;
  }
  const byEdgeCategory = {};
  for (const cat of graph.schema.edgeCategories) byEdgeCategory[cat.id] = 0;
  for (const edge of graph.edges) {
    byEdgeCategory[edge.category] = (byEdgeCategory[edge.category] ?? 0) + 1;
  }
  const groups = components(graph);
  const linked = new Set();
  for (const edge of graph.edges) {
    linked.add(edge.from);
    linked.add(edge.to);
  }
  return {
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    byNodeCategory,
    byEdgeCategory,
    components: groups.length,
    isolated: graph.nodes.filter((n) => !linked.has(n.id) && !n.parent).length,
  };
}

/* ------------------------------------------------------------------ *
 * Serialisation
 * ------------------------------------------------------------------ */

/** Pretty-printed JSON for file export. */
export function serialize(graph) {
  return `${JSON.stringify(graph, null, 2)}\n`;
}

/**
 * Parse and normalise an exported document.
 *
 * @param {string} text
 * @returns {{graph: object, validation: {ok: boolean, errors: string[], warnings: string[]}}}
 * @throws {SyntaxError} if the text is not JSON
 */
export function deserialize(text) {
  const parsed = JSON.parse(text);
  const validation = validateGraph(parsed);
  return { graph: normalizeGraph(parsed), validation };
}
