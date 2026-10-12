/**
 * Mezsgye Atlas — SVG map view.
 *
 * Owns rendering, hit-testing, panning/zooming, node dragging and an optional
 * force relaxation pass. It reads the live graph document and mutates only node
 * coordinates; every other change goes back to the app through handlers.
 */

import {
  childrenOf,
  edgeCost,
  getEdgeCategory,
  getNode,
  getNodeCategory,
} from '/shared/model.js';

const NS = 'http://www.w3.org/2000/svg';

/** Create an SVG element with attributes. */
function svgEl(name, attrs = {}) {
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    node.setAttribute(key, String(value));
  }
  return node;
}

/** Polygon points for a category shape, or null for circles. */
function shapePoints(shape, r) {
  const poly = (count, rotation, radius = r) => {
    const pts = [];
    for (let i = 0; i < count; i += 1) {
      const a = rotation + (i / count) * Math.PI * 2;
      pts.push(`${(Math.cos(a) * radius).toFixed(2)},${(Math.sin(a) * radius).toFixed(2)}`);
    }
    return pts.join(' ');
  };
  switch (shape) {
    case 'hex': return poly(6, -Math.PI / 2);
    case 'triangle': return poly(3, -Math.PI / 2);
    case 'diamond': return poly(4, -Math.PI / 2);
    case 'square': return `${-r},${-r} ${r},${-r} ${r},${r} ${-r},${r}`;
    case 'star': {
      const pts = [];
      for (let i = 0; i < 10; i += 1) {
        const radius = i % 2 === 0 ? r : r * 0.45;
        const a = -Math.PI / 2 + (i / 10) * Math.PI * 2;
        pts.push(`${(Math.cos(a) * radius).toFixed(2)},${(Math.sin(a) * radius).toFixed(2)}`);
      }
      return pts.join(' ');
    }
    default: return null;
  }
}

export class AtlasView {
  /**
   * @param {SVGSVGElement} svg
   * @param {{
   *   onSelect?: (sel: {type: string, id: string}|null) => void,
   *   onNodeMoved?: (id: string, x: number, y: number) => void,
   *   onCreateNodeAt?: (x: number, y: number) => void,
   *   onConnect?: (fromId: string, toId: string) => void,
   *   onRoute?: (fromId: string, toId: string) => void,
   *   onErase?: (sel: {type: string, id: string}) => void,
   *   onHint?: (text: string) => void,
   *   onLayoutChanged?: () => void,
   * }} handlers
   */
  constructor(svg, handlers = {}) {
    this.svg = svg;
    this.h = handlers;
    this.graph = null;

    this.layers = {
      tethers: svg.querySelector('#layer-tethers'),
      edges: svg.querySelector('#layer-edges'),
      edgeLabels: svg.querySelector('#layer-edge-labels'),
      nodes: svg.querySelector('#layer-nodes'),
      nodeLabels: svg.querySelector('#layer-node-labels'),
      overlay: svg.querySelector('#layer-overlay'),
    };
    this.viewport = svg.querySelector('#viewport');

    this.tx = 0;
    this.ty = 0;
    this.k = 1;

    this.tool = 'select';
    this.selection = null;
    this.route = null;
    this.showLabels = true;
    this.filterQuery = '';
    this.matched = null; // Set of ids when filtering, else null
    this.collapsed = new Set();

    this.nodeEls = new Map(); // id -> {g, shape, label, sub}
    this.edgeEls = new Map(); // id -> {g, line, inner, label}
    this.tetherEls = new Map();

    this.pendingLink = null; // first node id picked by link/route tool
    this.drag = null;
    this.pan = null;
    this.rubber = null;
    this.relaxHandle = null;
    this.flexible = false; // when true, force simulation runs continuously

    this.#bindEvents();
  }

  /* ---------------------------------------------------- public API */

  /** Attach a graph document and rebuild everything. */
  setGraph(graph) {
    this.graph = graph;
    this.collapsed = new Set([...this.collapsed].filter((id) => getNode(graph, id)));
    this.pendingLink = null;
    this.rebuild();
  }

  /** @param {string} tool one of select|add|connect|route|erase */
  setTool(tool) {
    this.tool = tool;
    this.pendingLink = null;
    this.#clearRubber();
    this.svg.classList.remove('tool-add', 'tool-connect', 'tool-route', 'tool-erase');
    if (tool !== 'select') this.svg.classList.add(`tool-${tool}`);
    this.#applyClasses();
  }

  /** @param {{type: 'node'|'edge', id: string}|null} sel */
  setSelection(sel) {
    this.selection = sel;
    this.#applyClasses();
  }

  /** Highlight a route, or clear it with null. */
  setRoute(route) {
    this.route = route;
    this.#applyClasses();
  }

  /** @param {boolean} on */
  setLabels(on) {
    this.showLabels = on;
    this.#applyLabelVisibility();
  }

  /**
   * Dim everything that does not match a free-text query.
   *
   * @param {string} query
   * @returns {number} number of matching nodes/edges
   */
  setFilter(query) {
    this.filterQuery = query.trim().toLowerCase();
    if (!this.filterQuery) {
      this.matched = null;
      this.#applyClasses();
      return 0;
    }
    const q = this.filterQuery;
    const matched = new Set();
    const hit = (value) => {
      if (value === null || value === undefined) return false;
      if (Array.isArray(value)) return value.some(hit);
      return String(value).toLowerCase().includes(q);
    };
    for (const node of this.graph?.nodes ?? []) {
      const cat = getNodeCategory(this.graph, node.category);
      if (hit(node.name) || hit(node.notes) || hit(cat?.label) || Object.values(node.data).some(hit)) {
        matched.add(node.id);
      }
    }
    for (const edge of this.graph?.edges ?? []) {
      const cat = getEdgeCategory(this.graph, edge.category);
      if (hit(edge.notes) || hit(cat?.label) || Object.values(edge.data).some(hit)) {
        matched.add(edge.id);
      }
    }
    this.matched = matched;
    this.#applyClasses();
    return matched.size;
  }

  /** Collapse/expand a node's children. */
  toggleCollapse(nodeId) {
    if (this.collapsed.has(nodeId)) this.collapsed.delete(nodeId);
    else this.collapsed.add(nodeId);
    this.rebuild();
  }

  /**
   * Collapse every node that has children.
   *
   * @returns {number} how many parent nodes were collapsed
   */
  collapseAll() {
    if (!this.graph) return 0;
    for (const node of this.graph.nodes) {
      if (childrenOf(this.graph, node.id).length) this.collapsed.add(node.id);
    }
    this.rebuild();
    return this.collapsed.size;
  }

  /** Expand every collapsed node. */
  expandAll() {
    const count = this.collapsed.size;
    this.collapsed.clear();
    this.rebuild();
    return count;
  }

  /** Is this node hidden because an ancestor is collapsed? */
  isHidden(node) {
    let cur = node;
    const guard = new Set();
    while (cur?.parent) {
      if (this.collapsed.has(cur.parent)) return true;
      if (guard.has(cur.parent)) return false;
      guard.add(cur.parent);
      cur = getNode(this.graph, cur.parent);
    }
    return false;
  }

  /** Full re-render from the graph document. */
  rebuild() {
    for (const layer of Object.values(this.layers)) layer.replaceChildren();
    this.nodeEls.clear();
    this.edgeEls.clear();
    this.tetherEls.clear();
    if (!this.graph) return;

    const visible = new Map();
    for (const node of this.graph.nodes) {
      if (!this.isHidden(node)) visible.set(node.id, node);
    }

    // Parallel-edge bookkeeping so duplicate links fan out instead of overlapping.
    const pairIndex = new Map();
    for (const edge of this.graph.edges) {
      if (!visible.has(edge.from) || !visible.has(edge.to)) continue;
      const key = edge.from < edge.to ? `${edge.from}|${edge.to}` : `${edge.to}|${edge.from}`;
      const seen = pairIndex.get(key) ?? 0;
      pairIndex.set(key, seen + 1);
      this.#createEdge(edge, seen);
    }

    for (const node of visible.values()) {
      if (node.parent && visible.has(node.parent)) this.#createTether(node);
    }
    for (const node of visible.values()) this.#createNode(node);

    this.#applyTransform();
    this.#applyClasses();
    this.#applyLabelVisibility();
    this.#updatePositions();
  }

  /** Fit all visible nodes into the viewport. */
  fit(padding = 70) {
    if (!this.graph || this.nodeEls.size === 0) return;
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (const id of this.nodeEls.keys()) {
      const node = getNode(this.graph, id);
      const cat = getNodeCategory(this.graph, node.category);
      const r = (cat?.size ?? 18) + 14;
      minX = Math.min(minX, node.x - r);
      maxX = Math.max(maxX, node.x + r);
      minY = Math.min(minY, node.y - r);
      maxY = Math.max(maxY, node.y + r);
    }
    const rect = this.svg.getBoundingClientRect();
    const w = Math.max(1, maxX - minX);
    const h = Math.max(1, maxY - minY);
    this.k = Math.min(
      (rect.width - padding * 2) / w,
      (rect.height - padding * 2) / h,
      2.5,
    );
    if (!Number.isFinite(this.k) || this.k <= 0) this.k = 1;
    this.tx = rect.width / 2 - ((minX + maxX) / 2) * this.k;
    this.ty = rect.height / 2 - ((minY + maxY) / 2) * this.k;
    this.#applyTransform();
    this.#applyLabelVisibility();
  }

  /** Pan so a node sits in the middle of the view. */
  centerOn(nodeId) {
    const node = getNode(this.graph, nodeId);
    if (!node) return;
    const rect = this.svg.getBoundingClientRect();
    this.tx = rect.width / 2 - node.x * this.k;
    this.ty = rect.height / 2 - node.y * this.k;
    this.#applyTransform();
  }

  /**
   * Run a force relaxation for a while, then stop.
   *
   * Repulsion between all visible nodes, springs along edges, children pulled
   * towards their parent, and a weak pull to the origin. Pinned nodes stay put.
   *
   * @param {number} ticks
   */
  relax(ticks = 220) {
    if (!this.graph) return;
    this.stopRelax();
    this.#runRelax(ticks, false);
  }

  /**
   * Turn continuous flexible mode on or off.
   *
   * In flexible mode the force simulation never stops: nodes drift under the
   * same forces as Relax, and you can grab and drag any node while the rest of
   * the layout keeps settling around it. Turning it off freezes everything
   * where it is.
   *
   * @param {boolean} on
   */
  setFlexible(on) {
    this.flexible = Boolean(on);
    this.stopRelax();
    if (this.flexible) {
      // Infinity ticks → the simulation loops forever at a steady, gentle alpha.
      this.#runRelax(Infinity, true);
    }
  }

  /**
   * The actual force loop, shared by one-shot Relax and continuous Flexible.
   *
   * @param {number} ticks  number of frames, or Infinity for continuous
   * @param {boolean} continuous  keep a steady alpha and never finalise
   */
  #runRelax(ticks, continuous) {
    let remaining = ticks;
    const refreshNodes = () => [...this.nodeEls.keys()].map((id) => getNode(this.graph, id));
    let nodes = refreshNodes();
    for (const node of nodes) {
      node._vx = 0;
      node._vy = 0;
    }

    const step = () => {
      // In continuous mode the node set can change (add/remove/collapse), so
      // re-read it each frame; the extra Map build is negligible at these sizes.
      if (continuous) nodes = refreshNodes();
      const byId = new Map(nodes.map((n) => [n.id, n]));
      // Continuous mode holds a steady, gentle alpha; one-shot cools down.
      const alpha = continuous ? 0.35 : Math.max(0.02, remaining / ticks);
      for (const node of nodes) {
        node._fx = 0;
        node._fy = 0;
      }
      // Repulsion.
      for (let i = 0; i < nodes.length; i += 1) {
        for (let j = i + 1; j < nodes.length; j += 1) {
          const a = nodes[i];
          const b = nodes[j];
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 0.01) {
            dx = (Math.random() - 0.5) * 2;
            dy = (Math.random() - 0.5) * 2;
            d2 = dx * dx + dy * dy;
          }
          const d = Math.sqrt(d2);
          const force = 26000 / d2;
          const fx = (dx / d) * force;
          const fy = (dy / d) * force;
          a._fx -= fx; a._fy -= fy;
          b._fx += fx; b._fy += fy;
        }
      }
      // Springs along links.
      for (const edge of this.graph.edges) {
        const a = byId.get(edge.from);
        const b = byId.get(edge.to);
        if (!a || !b) continue;
        const rest = 150 + edgeCost(edge) * 35;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.max(1, Math.hypot(dx, dy));
        const force = (d - rest) * 0.035;
        const fx = (dx / d) * force;
        const fy = (dy / d) * force;
        a._fx += fx; a._fy += fy;
        b._fx -= fx; b._fy -= fy;
      }
      // Containment: children orbit their parent closely.
      for (const node of nodes) {
        if (!node.parent) continue;
        const parent = byId.get(node.parent);
        if (!parent) continue;
        const dx = parent.x - node.x;
        const dy = parent.y - node.y;
        const d = Math.max(1, Math.hypot(dx, dy));
        const force = (d - 95) * 0.12;
        node._fx += (dx / d) * force;
        node._fy += (dy / d) * force;
        parent._fx -= (dx / d) * force * 0.2;
        parent._fy -= (dy / d) * force * 0.2;
      }
      // Weak gravity so disconnected pieces do not drift forever.
      for (const node of nodes) {
        node._fx -= node.x * 0.002;
        node._fy -= node.y * 0.002;
      }
      for (const node of nodes) {
        if (node.pinned || this.drag?.ids?.has(node.id)) continue;
        node._vx = (node._vx + node._fx) * 0.78;
        node._vy = (node._vy + node._fy) * 0.78;
        node.x += node._vx * alpha;
        node.y += node._vy * alpha;
      }
      this.#updatePositions();
      remaining -= 1;
      if (remaining > 0) {
        this.relaxHandle = requestAnimationFrame(step);
      } else {
        this.relaxHandle = null;
        for (const node of nodes) {
          delete node._vx; delete node._vy; delete node._fx; delete node._fy;
        }
        this.h.onLayoutChanged?.();
      }
    };
    this.relaxHandle = requestAnimationFrame(step);
  }

  /** Stop an in-flight relaxation. */
  stopRelax() {
    if (this.relaxHandle !== null) {
      cancelAnimationFrame(this.relaxHandle);
      this.relaxHandle = null;
    }
  }

  /** Convert a pointer event to world coordinates. */
  worldFromEvent(evt) {
    const rect = this.svg.getBoundingClientRect();
    return {
      x: (evt.clientX - rect.left - this.tx) / this.k,
      y: (evt.clientY - rect.top - this.ty) / this.k,
    };
  }

  /* ----------------------------------------------- element building */

  #createNode(node) {
    const cat = getNodeCategory(this.graph, node.category);
    const color = cat?.color ?? '#8b6cff';
    const r = cat?.size ?? 18;

    const g = svgEl('g', { class: 'node', 'data-node-id': node.id, style: `color:${color}` });
    const points = shapePoints(cat?.shape ?? 'circle', r);
    const shape = points
      ? svgEl('polygon', { class: 'node-shape', points, fill: color })
      : svgEl('circle', { class: 'node-shape', r, fill: color });
    g.append(shape);

    if (node.pinned) {
      g.append(svgEl('circle', { class: 'node-pin', r: 2.4, cx: r * 0.62, cy: -r * 0.62 }));
    }

    const kids = childrenOf(this.graph, node.id);
    if (kids.length) {
      const badge = svgEl('g', {
        class: 'collapse-badge',
        'data-collapse-id': node.id,
        transform: `translate(${r * 0.95},${r * 0.95})`,
      });
      badge.append(svgEl('circle', { r: 7.5 }));
      const label = svgEl('text', { y: 0.5 });
      label.textContent = this.collapsed.has(node.id) ? String(kids.length) : '−';
      badge.append(label);
      const badgeTitle = svgEl('title');
      badgeTitle.textContent = this.collapsed.has(node.id)
        ? `Show ${kids.length} contained node(s)`
        : 'Hide contained nodes';
      badge.append(badgeTitle);
      g.append(badge);
    }

    const title = svgEl('title');
    title.textContent = `${node.name} — ${cat?.label ?? node.category}`;
    g.append(title);

    const label = svgEl('text', { class: 'node-label', 'data-label-for': node.id });
    label.textContent = node.name;
    const sub = svgEl('text', { class: 'node-label sub', 'data-label-for': node.id });
    sub.textContent = cat?.label ?? node.category;

    this.layers.nodes.append(g);
    this.layers.nodeLabels.append(label, sub);
    this.nodeEls.set(node.id, { g, shape, label, sub, r });
  }

  #createEdge(edge, parallelIndex) {
    const cat = getEdgeCategory(this.graph, edge.category);
    const color = cat?.color ?? '#8b6cff';
    const width = cat?.width ?? 2.5;

    const g = svgEl('g', { class: 'edge', 'data-edge-id': edge.id });
    const hit = svgEl('path', { class: 'edge-hit' });
    const line = svgEl('path', {
      class: `edge-line style-${cat?.style ?? 'solid'}`,
      stroke: color,
      'stroke-width': width,
    });
    g.append(hit, line);

    let inner = null;
    if (cat?.style === 'double') {
      inner = svgEl('path', { class: 'edge-line', stroke: '#0a0912', 'stroke-width': Math.max(0.8, width * 0.4) });
      g.append(inner);
    }

    const title = svgEl('title');
    title.textContent = `${edge.notes || cat?.label || edge.category} (${cat?.label ?? ''}) — cost ${edgeCost(edge)}`;
    g.append(title);

    const label = svgEl('text', { class: 'edge-label', 'data-edge-label-for': edge.id });
    label.textContent = edge.notes || cat?.label || '';

    this.layers.edges.append(g);
    this.layers.edgeLabels.append(label);
    this.edgeEls.set(edge.id, { g, hit, line, inner, label, offset: parallelIndex });
  }

  #createTether(node) {
    const line = svgEl('path', { class: 'tether', 'data-tether-for': node.id });
    this.layers.tethers.append(line);
    this.tetherEls.set(node.id, line);
  }

  /* -------------------------------------------------- positioning */

  #updatePositions() {
    if (!this.graph) return;
    for (const [id, refs] of this.nodeEls) {
      const node = getNode(this.graph, id);
      if (!node) continue;
      refs.g.setAttribute('transform', `translate(${node.x.toFixed(2)},${node.y.toFixed(2)})`);
      refs.label.setAttribute('x', node.x.toFixed(2));
      refs.label.setAttribute('y', (node.y + refs.r + 13).toFixed(2));
      refs.sub.setAttribute('x', node.x.toFixed(2));
      refs.sub.setAttribute('y', (node.y + refs.r + 24).toFixed(2));
    }
    for (const [id, refs] of this.edgeEls) {
      const edge = this.graph.edges.find((e) => e.id === id);
      if (!edge) continue;
      const a = getNode(this.graph, edge.from);
      const b = getNode(this.graph, edge.to);
      if (!a || !b) continue;
      const d = this.#edgePath(a, b, refs.offset);
      refs.hit.setAttribute('d', d.path);
      refs.line.setAttribute('d', d.path);
      refs.inner?.setAttribute('d', d.path);
      refs.label.setAttribute('x', d.mid.x.toFixed(2));
      refs.label.setAttribute('y', (d.mid.y - 6).toFixed(2));
    }
    for (const [id, line] of this.tetherEls) {
      const node = getNode(this.graph, id);
      const parent = node && getNode(this.graph, node.parent);
      if (!node || !parent) continue;
      line.setAttribute('d', `M${parent.x.toFixed(2)},${parent.y.toFixed(2)}L${node.x.toFixed(2)},${node.y.toFixed(2)}`);
    }
    if (this.rubber && this.pendingLink) {
      const a = getNode(this.graph, this.pendingLink);
      if (a) {
        this.rubber.setAttribute('x1', a.x);
        this.rubber.setAttribute('y1', a.y);
      }
    }
  }

  /** Straight line, or a bowed quadratic for parallel links. */
  #edgePath(a, b, offset = 0) {
    if (!offset) {
      return {
        path: `M${a.x.toFixed(2)},${a.y.toFixed(2)}L${b.x.toFixed(2)},${b.y.toFixed(2)}`,
        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      };
    }
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.max(1, Math.hypot(dx, dy));
    const bow = (offset % 2 === 1 ? 1 : -1) * Math.ceil(offset / 2) * 26;
    const cx = (a.x + b.x) / 2 + (-dy / len) * bow;
    const cy = (a.y + b.y) / 2 + (dx / len) * bow;
    return {
      path: `M${a.x.toFixed(2)},${a.y.toFixed(2)}Q${cx.toFixed(2)},${cy.toFixed(2)} ${b.x.toFixed(2)},${b.y.toFixed(2)}`,
      mid: { x: (a.x + 2 * cx + b.x) / 4, y: (a.y + 2 * cy + b.y) / 4 },
    };
  }

  #applyTransform() {
    this.viewport.setAttribute(
      'transform',
      `translate(${this.tx.toFixed(2)},${this.ty.toFixed(2)}) scale(${this.k.toFixed(4)})`,
    );
  }

  #applyClasses() {
    const routeNodes = new Set(this.route?.nodes ?? []);
    const routeEdges = new Set(this.route?.edges ?? []);
    for (const [id, refs] of this.nodeEls) {
      refs.g.classList.toggle('selected', this.selection?.type === 'node' && this.selection.id === id);
      refs.g.classList.toggle('route', routeNodes.has(id));
      refs.g.classList.toggle('pending', this.pendingLink === id);
      const dim = this.matched ? !this.matched.has(id) : false;
      refs.g.classList.toggle('dimmed', dim);
      refs.label.classList.toggle('dimmed', dim);
      refs.sub.classList.toggle('dimmed', dim);
    }
    for (const [id, refs] of this.edgeEls) {
      refs.g.classList.toggle('selected', this.selection?.type === 'edge' && this.selection.id === id);
      refs.g.classList.toggle('route', routeEdges.has(id));
      refs.g.classList.toggle('dimmed', this.matched ? !this.matched.has(id) : false);
    }
  }

  #applyLabelVisibility() {
    const showNames = this.showLabels && this.k > 0.42;
    const showSub = this.showLabels && this.k > 0.95;
    const showEdges = this.showLabels && this.k > 0.78;
    this.layers.nodeLabels.style.display = showNames ? '' : 'none';
    this.layers.edgeLabels.style.display = showEdges ? '' : 'none';
    for (const refs of this.nodeEls.values()) {
      refs.sub.style.display = showSub ? '' : 'none';
    }
  }

  /* ------------------------------------------------------- events */

  #bindEvents() {
    this.svg.addEventListener('pointerdown', (evt) => this.#onPointerDown(evt));
    this.svg.addEventListener('pointermove', (evt) => this.#onPointerMove(evt));
    this.svg.addEventListener('pointerup', (evt) => this.#onPointerUp(evt));
    this.svg.addEventListener('pointercancel', () => this.#endInteraction());
    this.svg.addEventListener('wheel', (evt) => this.#onWheel(evt), { passive: false });
    this.svg.addEventListener('dblclick', (evt) => this.#onDoubleClick(evt));
    this.svg.addEventListener('contextmenu', (evt) => {
      const nodeId = evt.target.closest?.('[data-node-id]')?.dataset.nodeId;
      if (!nodeId) return;
      evt.preventDefault();
      const node = getNode(this.graph, nodeId);
      node.pinned = !node.pinned;
      this.h.onLayoutChanged?.();
      this.rebuild();
      this.h.onHint?.(node.pinned ? `${node.name} pinned` : `${node.name} unpinned`);
    });
    window.addEventListener('resize', () => this.#applyLabelVisibility());
  }

  #pick(evt) {
    const nodeEl = evt.target.closest?.('[data-node-id]');
    if (nodeEl) return { type: 'node', id: nodeEl.dataset.nodeId };
    const edgeEl = evt.target.closest?.('[data-edge-id]');
    if (edgeEl) return { type: 'edge', id: edgeEl.dataset.edgeId };
    return null;
  }

  /**
   * Collect the descendants that should move together with a dragged node.
   *
   * Walks the containment tree below `rootId` and returns every child that is
   * not pinned. A pinned node stays put, and the walk stops descending into it
   * so its own children keep orbiting it rather than the node being dragged.
   *
   * @param {string} rootId
   * @returns {Array<object>} node objects to drag along
   */
  #draggableDescendants(rootId) {
    const result = [];
    const seen = new Set([rootId]);
    const walk = (parentId) => {
      for (const child of childrenOf(this.graph, parentId)) {
        if (seen.has(child.id)) continue; // guard against cyclic parents
        seen.add(child.id);
        if (child.pinned) continue; // pinned children (and their subtree) stay
        result.push(child);
        walk(child.id);
      }
    };
    walk(rootId);
    return result;
  }

  #onPointerDown(evt) {
    if (evt.button === 2) return;
    this.svg.focus({ preventScroll: true });

    const collapseEl = evt.target.closest?.('[data-collapse-id]');
    if (collapseEl) {
      evt.preventDefault();
      this.toggleCollapse(collapseEl.dataset.collapseId);
      return;
    }

    const hit = this.#pick(evt);

    if (this.tool === 'erase') {
      if (hit) {
        evt.preventDefault();
        this.h.onErase?.(hit);
      }
      return;
    }

    if ((this.tool === 'connect' || this.tool === 'route') && hit?.type === 'node') {
      evt.preventDefault();
      if (!this.pendingLink) {
        this.pendingLink = hit.id;
        this.#startRubber(hit.id);
        this.#applyClasses();
        const name = getNode(this.graph, hit.id)?.name;
        this.h.onHint?.(this.tool === 'connect'
          ? `Linking from ${name} — click the far end (Esc to cancel)`
          : `Route from ${name} — click the destination (Esc to cancel)`);
      } else if (this.pendingLink !== hit.id) {
        const from = this.pendingLink;
        this.pendingLink = null;
        this.#clearRubber();
        if (this.tool === 'connect') this.h.onConnect?.(from, hit.id);
        else this.h.onRoute?.(from, hit.id);
        this.#applyClasses();
      }
      return;
    }

    if (this.tool === 'add' && !hit) {
      evt.preventDefault();
      const { x, y } = this.worldFromEvent(evt);
      this.h.onCreateNodeAt?.(x, y);
      return;
    }

    if (hit) {
      evt.preventDefault();
      this.h.onSelect?.(hit);
      if (hit.type === 'node' && this.tool === 'select') {
        const node = getNode(this.graph, hit.id);
        const start = this.worldFromEvent(evt);
        // Children (recursively) follow the parent, unless they are pinned.
        const followers = this.#draggableDescendants(hit.id);
        this.drag = {
          id: hit.id,
          dx: node.x - start.x,
          dy: node.y - start.y,
          moved: false,
          pointerId: evt.pointerId,
          // Every node the physics loop must leave alone while this drag runs.
          ids: new Set([hit.id, ...followers.map((f) => f.id)]),
          // Each follower's offset relative to the dragged node, so the whole
          // group keeps its shape as it moves.
          followers: followers.map((child) => ({
            id: child.id,
            ox: child.x - node.x,
            oy: child.y - node.y,
          })),
        };
        this.svg.setPointerCapture(evt.pointerId);
      }
      return;
    }

    // Empty space: deselect and pan.
    this.h.onSelect?.(null);
    this.pan = { x: evt.clientX, y: evt.clientY, tx: this.tx, ty: this.ty, pointerId: evt.pointerId };
    this.svg.classList.add('panning');
    this.svg.setPointerCapture(evt.pointerId);
  }

  #onPointerMove(evt) {
    if (this.drag) {
      const p = this.worldFromEvent(evt);
      const node = getNode(this.graph, this.drag.id);
      if (!node) return;
      node.x = p.x + this.drag.dx;
      node.y = p.y + this.drag.dy;
      // Drag the group: each unpinned descendant keeps its relative offset.
      for (const f of this.drag.followers ?? []) {
        const child = getNode(this.graph, f.id);
        if (!child) continue;
        child.x = node.x + f.ox;
        child.y = node.y + f.oy;
      }
      this.drag.moved = true;
      this.#updatePositions();
      return;
    }
    if (this.pan) {
      this.tx = this.pan.tx + (evt.clientX - this.pan.x);
      this.ty = this.pan.ty + (evt.clientY - this.pan.y);
      this.#applyTransform();
      return;
    }
    if (this.rubber) {
      const p = this.worldFromEvent(evt);
      this.rubber.setAttribute('x2', p.x.toFixed(2));
      this.rubber.setAttribute('y2', p.y.toFixed(2));
    }
  }

  #onPointerUp(evt) {
    if (this.drag) {
      const { id, moved } = this.drag;
      this.drag = null;
      try { this.svg.releasePointerCapture(evt.pointerId); } catch { /* already released */ }
      if (moved) {
        const node = getNode(this.graph, id);
        // In flexible mode leave the node unpinned so it keeps floating with
        // the live simulation. Otherwise pin only the node you grabbed;
        // followers stay unpinned so they keep following future moves.
        if (!this.flexible) node.pinned = true;
        this.rebuild();
        this.h.onNodeMoved?.(id, node.x, node.y);
      }
      return;
    }
    this.#endInteraction(evt);
  }

  #endInteraction(evt) {
    if (this.pan) {
      this.pan = null;
      this.svg.classList.remove('panning');
      if (evt) {
        try { this.svg.releasePointerCapture(evt.pointerId); } catch { /* already released */ }
      }
    }
  }

  #onWheel(evt) {
    evt.preventDefault();
    const rect = this.svg.getBoundingClientRect();
    const px = evt.clientX - rect.left;
    const py = evt.clientY - rect.top;
    const world = { x: (px - this.tx) / this.k, y: (py - this.ty) / this.k };
    const factor = Math.exp(-evt.deltaY * 0.0014);
    this.k = Math.min(4, Math.max(0.08, this.k * factor));
    this.tx = px - world.x * this.k;
    this.ty = py - world.y * this.k;
    this.#applyTransform();
    this.#applyLabelVisibility();
  }

  #onDoubleClick(evt) {
    const hit = this.#pick(evt);
    if (hit?.type === 'node') {
      this.toggleCollapse(hit.id);
      return;
    }
    if (!hit && this.tool === 'select') {
      const { x, y } = this.worldFromEvent(evt);
      this.h.onCreateNodeAt?.(x, y);
    }
  }

  /** Cancel a pending link/route pick. */
  cancelPending() {
    if (!this.pendingLink) return false;
    this.pendingLink = null;
    this.#clearRubber();
    this.#applyClasses();
    return true;
  }

  #startRubber(fromId) {
    const node = getNode(this.graph, fromId);
    this.#clearRubber();
    this.rubber = svgEl('line', {
      class: 'rubber', x1: node.x, y1: node.y, x2: node.x, y2: node.y,
    });
    this.layers.overlay.append(this.rubber);
  }

  #clearRubber() {
    this.rubber?.remove();
    this.rubber = null;
  }
}
