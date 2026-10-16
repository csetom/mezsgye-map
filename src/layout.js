/**
 * Mezsgye Atlas — force layout step.
 *
 * Pure ESM, shared by the browser view and the tests. One call advances the
 * simulation by a single tick. Velocities live in a side table (a Map keyed by
 * node id) rather than on the node objects, so nodes added mid-simulation (e.g.
 * placed while flexible mode is running) simply start at rest, and nothing
 * transient ever leaks into a saved document.
 */

import { edgeCost } from './model.js';

/**
 * Advance the force simulation by one tick. Mutates node `x`/`y` in place.
 *
 * Repulsion between all given nodes, springs along edges, children pulled
 * towards their parent, and a weak pull to the origin. Pinned nodes and nodes
 * in `frozen` are not moved (but still exert force).
 *
 * @param {object[]} nodes        nodes taking part (null/undefined entries are ignored)
 * @param {object[]} edges        all edges; ones touching absent nodes are skipped
 * @param {Map<string, {vx: number, vy: number}>} velocity  per-node velocity, updated in place
 * @param {{alpha?: number, frozen?: Set<string>, rng?: () => number}} [opts]
 */
export function forceStep(nodes, edges, velocity, opts = {}) {
  const alpha = opts.alpha ?? 0.35;
  const frozen = opts.frozen ?? new Set();
  const rng = opts.rng ?? Math.random;

  // Drop missing nodes and repair any non-finite coordinates so one bad value
  // can never poison the whole layout.
  const live = [];
  for (const node of nodes) {
    if (!node) continue;
    if (!Number.isFinite(node.x)) node.x = 0;
    if (!Number.isFinite(node.y)) node.y = 0;
    live.push(node);
  }
  const byId = new Map(live.map((n) => [n.id, n]));
  const force = new Map(live.map((n) => [n.id, { x: 0, y: 0 }]));

  // Repulsion.
  for (let i = 0; i < live.length; i += 1) {
    for (let j = i + 1; j < live.length; j += 1) {
      const a = live[i];
      const b = live[j];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 0.01) {
        dx = (rng() - 0.5) * 2 || 0.5;
        dy = (rng() - 0.5) * 2 || 0.5;
        d2 = dx * dx + dy * dy;
      }
      const d = Math.sqrt(d2);
      const f = 26000 / d2;
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      force.get(a.id).x -= fx; force.get(a.id).y -= fy;
      force.get(b.id).x += fx; force.get(b.id).y += fy;
    }
  }

  // Springs along links; rest length grows with travel hours (log-scaled so a
  // 3-month street does not fly off the screen).
  for (const edge of edges) {
    const a = byId.get(edge.from);
    const b = byId.get(edge.to);
    if (!a || !b) continue;
    const rest = 150 + Math.log2(1 + edgeCost(edge)) * 25;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.max(1, Math.hypot(dx, dy));
    const f = (d - rest) * 0.035;
    const fx = (dx / d) * f;
    const fy = (dy / d) * f;
    force.get(a.id).x += fx; force.get(a.id).y += fy;
    force.get(b.id).x -= fx; force.get(b.id).y -= fy;
  }

  // Containment: children orbit their parent closely.
  for (const node of live) {
    if (!node.parent) continue;
    const parent = byId.get(node.parent);
    if (!parent) continue;
    const dx = parent.x - node.x;
    const dy = parent.y - node.y;
    const d = Math.max(1, Math.hypot(dx, dy));
    const f = (d - 95) * 0.12;
    force.get(node.id).x += (dx / d) * f;
    force.get(node.id).y += (dy / d) * f;
    force.get(parent.id).x -= (dx / d) * f * 0.2;
    force.get(parent.id).y -= (dy / d) * f * 0.2;
  }

  // Weak gravity so disconnected pieces do not drift forever.
  for (const node of live) {
    force.get(node.id).x -= node.x * 0.002;
    force.get(node.id).y -= node.y * 0.002;
  }

  for (const node of live) {
    if (node.pinned || frozen.has(node.id)) {
      velocity.set(node.id, { vx: 0, vy: 0 });
      continue;
    }
    const v = velocity.get(node.id) ?? { vx: 0, vy: 0 };
    const f = force.get(node.id);
    v.vx = (v.vx + f.x) * 0.78;
    v.vy = (v.vy + f.y) * 0.78;
    if (!Number.isFinite(v.vx) || !Number.isFinite(v.vy)) {
      v.vx = 0;
      v.vy = 0;
    }
    velocity.set(node.id, v);
    node.x += v.vx * alpha;
    node.y += v.vy * alpha;
  }

  // Forget nodes that are gone.
  for (const id of velocity.keys()) {
    if (!byId.has(id)) velocity.delete(id);
  }
}
