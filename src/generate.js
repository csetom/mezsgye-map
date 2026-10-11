/**
 * Mezsgye Atlas — procedural atlas generation.
 *
 * Builds a connected sector map with essence streets between sectors, worlds
 * nested inside sectors, and optional waystations/anomalies sitting on the
 * network. Deterministic for a given seed. Pure ESM, shared by server and
 * browser.
 */

import {
  addEdge,
  addNode,
  createEmptyGraph,
  defaultSchema,
  makeRng,
  pick,
  randInt,
} from './model.js';
import { createNamer } from './names.js';

/** Defaults used when the caller omits an option. */
export const GENERATOR_DEFAULTS = {
  seed: 1,
  sectors: 8,
  worldsMin: 1,
  worldsMax: 4,
  /** Extra streets beyond the spanning tree, as a fraction of sector count. */
  extraStreets: 0.6,
  /** Chance per extra street that it is a weak "minor current" instead. */
  minorCurrentChance: 0.35,
  /** Chance per sector of hosting a waystation / an anomaly. */
  waystationChance: 0.25,
  anomalyChance: 0.18,
  /** Chance a street is marked as collapsed. */
  collapsedChance: 0.07,
  /** Layout radius for the sector ring, in world units. */
  radius: 420,
  title: 'Generated Atlas',
};

const DENSITIES = ['dead', 'thin', 'stable', 'stable', 'rich', 'volatile'];
const ACCESS = ['open', 'open', 'tolled', 'warded', 'forbidden', 'unknown'];
const WORLD_TYPES = ['terrestrial', 'oceanic', 'shard', 'city-world', 'wild', 'dead'];
const REACHABLE = ['void-side', 'outside-only', 'both', 'both'];
const MAGIC = ['null', 'faint', 'common', 'common', 'saturated'];
const CURRENTS = ['sluggish', 'steady', 'steady', 'swift', 'torrential'];
const SECTOR_HAZARDS = [
  'essence undertow', 'wave shear', 'silence', 'drifting wrecks', 'toll patrols',
  'memory bleed', 'compass rot', 'star-blind fog',
];
const SERVICES = ['essence tap', 'repairs', 'berths', 'fence', 'charts', 'healer', 'bar'];
const PHENOMENA = [
  'a knot in the current', 'a wave that runs backwards', 'a wreck that is still arriving',
  'a chorus with no singers', 'a sector that is not on any chart',
  'an essence bloom that thinks',
];

/**
 * Generate a fresh atlas.
 *
 * @param {Partial<typeof GENERATOR_DEFAULTS>} [options]
 * @returns {object} a normalized graph document
 */
export function generateAtlas(options = {}) {
  const opt = { ...GENERATOR_DEFAULTS, ...options };
  const sectorCount = Math.max(1, Math.min(200, Math.floor(opt.sectors)));
  const worldsMin = Math.max(0, Math.floor(opt.worldsMin));
  const worldsMax = Math.max(worldsMin, Math.floor(opt.worldsMax));

  const rng = makeRng(opt.seed);
  const namer = createNamer(rng);
  const graph = createEmptyGraph({
    title: opt.title,
    subtitle: `seed ${opt.seed} · ${sectorCount} sectors`,
    schema: defaultSchema(),
  });
  graph.meta.notes =
    'Generated map. Sectors sit on the ring; worlds are nested inside their sector; '
    + 'essence streets carry void makers between sectors.';

  /* --- sectors, laid out on a jittered ring (or spiral if crowded) --- */
  const sectors = [];
  const ringCount = Math.max(1, Math.ceil(sectorCount / 12));
  for (let i = 0; i < sectorCount; i += 1) {
    const ring = Math.floor(i / 12);
    const inRing = Math.min(12, sectorCount - ring * 12);
    const angle = ((i % 12) / inRing) * Math.PI * 2 + ring * 0.4;
    const radius = opt.radius * ((ring + 1) / ringCount) * (0.8 + rng() * 0.35);
    const name = namer.sector();
    const node = addNode(graph, {
      name,
      category: 'sector',
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      data: {
        essence_density: pick(rng, DENSITIES),
        access: pick(rng, ACCESS),
        ruling_power: rng() < 0.55 ? `${pick(rng, ['Céh', 'Konzorcium', 'Rend', 'Szindikátus', 'Tanács'])} of ${name}` : '',
        hazards: rng() < 0.6 ? [pick(rng, SECTOR_HAZARDS)] : [],
        discovered: rng() > 0.12,
        description: '',
      },
    });
    sectors.push(node);
  }

  /* --- worlds inside each sector --- */
  for (const sector of sectors) {
    const count = randInt(rng, worldsMin, worldsMax);
    for (let w = 0; w < count; w += 1) {
      const angle = (w / Math.max(1, count)) * Math.PI * 2 + rng();
      const dist = 70 + rng() * 45;
      addNode(graph, {
        name: namer.world(sector.name, w + 1),
        category: 'world',
        parent: sector.id,
        x: sector.x + Math.cos(angle) * dist,
        y: sector.y + Math.sin(angle) * dist,
        data: {
          world_type: pick(rng, WORLD_TYPES),
          reachable_from: pick(rng, REACHABLE),
          magic_level: pick(rng, MAGIC),
          population: pick(rng, ['uninhabited', 'scattered', 'a few holdfasts', 'populous', 'teeming']),
          factions: [],
          hooks: '',
        },
      });
    }
  }

  /* --- street network: random spanning tree first, so the map is connected --- */
  const streetNames = new Map();
  function street(a, b, category) {
    const name = namer.street();
    const edge = addEdge(graph, {
      from: a.id,
      to: b.id,
      category,
      data: {
        cost: category === 'minor_current' ? randInt(rng, 2, 4) : randInt(rng, 1, 3),
        travel_time: `${randInt(rng, 1, 9)} ${pick(rng, ['hours', 'days', 'watches'])}`,
        current_strength: pick(rng, CURRENTS),
        void_maker_required: category !== 'minor_current' || rng() < 0.5,
        hazards: rng() < 0.35 ? [pick(rng, SECTOR_HAZARDS)] : [],
        description: `Known to pilots as ${name}.`,
      },
    });
    streetNames.set(edge.id, name);
    return edge;
  }

  const connected = sectors.length ? [sectors[0]] : [];
  const pending = sectors.slice(1);
  while (pending.length) {
    const nextIndex = Math.floor(rng() * pending.length);
    const node = pending.splice(nextIndex, 1)[0];
    // Prefer attaching to a nearby sector so the drawing stays readable.
    const anchors = [...connected]
      .sort((a, b) => dist2(a, node) - dist2(b, node))
      .slice(0, 3);
    street(pick(rng, anchors), node, 'essence_street');
    connected.push(node);
  }

  /* --- extra links for loops and alternate routes --- */
  const extra = Math.round(sectorCount * opt.extraStreets);
  const existing = new Set(graph.edges.map((e) => pairKey(e.from, e.to)));
  for (let i = 0; i < extra * 4 && existing.size < sectorCount * 3; i += 1) {
    if (graph.edges.length >= sectorCount - 1 + extra) break;
    const a = pick(rng, sectors);
    const candidates = sectors
      .filter((s) => s.id !== a.id && !existing.has(pairKey(a.id, s.id)))
      .sort((x, y) => dist2(a, x) - dist2(a, y))
      .slice(0, 4);
    if (!candidates.length) continue;
    const b = pick(rng, candidates);
    const category = rng() < opt.minorCurrentChance
      ? 'minor_current'
      : (rng() < opt.collapsedChance ? 'collapsed_route' : 'essence_street');
    street(a, b, category);
    existing.add(pairKey(a.id, b.id));
  }

  /* --- waystations and anomalies, hung off a sector --- */
  for (const sector of sectors) {
    if (rng() < opt.waystationChance) {
      const angle = rng() * Math.PI * 2;
      const station = addNode(graph, {
        name: namer.station(),
        category: 'waystation',
        x: sector.x + Math.cos(angle) * 150,
        y: sector.y + Math.sin(angle) * 150,
        data: {
          operator: pick(rng, ['independent', 'guild-held', 'void maker cartel', 'nobody admits to it']),
          services: [pick(rng, SERVICES), pick(rng, SERVICES)],
          safety: pick(rng, ['sanctuary', 'neutral', 'neutral', 'rough', 'trap']),
          description: '',
        },
      });
      street(sector, station, 'minor_current');
    }
    if (rng() < opt.anomalyChance) {
      const angle = rng() * Math.PI * 2;
      const anomaly = addNode(graph, {
        name: namer.anomaly(),
        category: 'anomaly',
        x: sector.x + Math.cos(angle) * 185,
        y: sector.y + Math.sin(angle) * 185,
        data: {
          phenomenon: pick(rng, PHENOMENA),
          danger: pick(rng, ['low', 'moderate', 'moderate', 'severe', 'lethal']),
          effect: '',
        },
      });
      if (rng() < 0.6) street(sector, anomaly, 'collapsed_route');
    }
  }

  // Fold generated street names into edge notes so they survive export.
  for (const edge of graph.edges) {
    const name = streetNames.get(edge.id);
    if (name) edge.notes = name;
  }

  return graph;
}

function dist2(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}
