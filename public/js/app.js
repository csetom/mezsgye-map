/**
 * Mezsgye Atlas — application wiring.
 *
 * Holds the one live graph document, routes every user action through the
 * shared model mutators, and keeps the view, inspector, legend and status bar
 * in sync. Persistence is either a named file on the server or a plain JSON
 * download/upload.
 */

import {
  addEdge,
  addNode,
  createEmptyGraph,
  defaultSchema,
  deserialize,
  findRoute,
  getEdgeCategory,
  getNode,
  getNodeCategory,
  graphStats,
  removeEdge,
  removeNode,
  serialize,
  updateEdge,
  updateNode,
} from '/shared/model.js';
import { GENERATOR_DEFAULTS, generateAtlas } from '/shared/generate.js';
import { api } from './api.js';
import { AtlasView } from './graph.js';
import { Inspector } from './inspector.js';
import { CategoryManager } from './categories.js';

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

const state = {
  graph: createEmptyGraph({ title: 'Untitled Atlas', schema: defaultSchema() }),
  /** Stored file slug, or null when the atlas only exists in the browser. */
  file: null,
  dirty: false,
  selection: null,
  tool: 'select',
};

const $ = (sel) => document.querySelector(sel);

const dom = {
  svg: $('#canvas'),
  inspector: $('#inspector-body'),
  fileSelect: $('#file-select'),
  titleLine: $('#atlas-title-line'),
  search: $('#search'),
  searchCount: $('#search-count'),
  placeCategory: $('#place-category'),
  linkCategory: $('#link-category'),
  legend: $('#legend'),
  toast: $('#toast'),
  hintBar: $('#hint-bar'),
  statusStats: $('#status-stats'),
  statusDirty: $('#status-dirty'),
  statusSelection: $('#status-selection'),
  importInput: $('#import-input'),
  dlgGenerate: $('#dlg-generate'),
  dlgCategories: $('#dlg-categories'),
  dlgMeta: $('#dlg-meta'),
  dlgPrompt: $('#dlg-prompt'),
};

/* ------------------------------------------------------------------ *
 * Feedback helpers
 * ------------------------------------------------------------------ */

let toastHandle = null;

/**
 * Flash a message in the corner.
 *
 * @param {string} message
 * @param {'info'|'ok'|'error'} [kind]
 */
function toast(message, kind = 'info') {
  dom.toast.textContent = message;
  dom.toast.className = `toast show ${kind === 'info' ? '' : kind}`.trim();
  clearTimeout(toastHandle);
  toastHandle = setTimeout(() => {
    dom.toast.className = 'toast';
  }, kind === 'error' ? 6000 : 2800);
}

let hintHandle = null;

/** Show a transient instruction above the canvas. */
function hint(message) {
  dom.hintBar.textContent = message;
  dom.hintBar.classList.add('show');
  clearTimeout(hintHandle);
  hintHandle = setTimeout(() => dom.hintBar.classList.remove('show'), 4000);
}

/**
 * Modal text prompt backed by <dialog>.
 *
 * @param {{title: string, label: string, value?: string, note?: string}} opts
 * @returns {Promise<string|null>}
 */
function askText({ title, label, value = '', note = '' }) {
  const dialog = dom.dlgPrompt;
  dialog.querySelector('#prompt-title').textContent = title;
  dialog.querySelector('#prompt-label').firstChild.textContent = `${label} `;
  dialog.querySelector('#prompt-note').textContent = note;
  const input = dialog.querySelector('input[name="value"]');
  input.value = value;
  return new Promise((resolve) => {
    const onClose = () => {
      dialog.removeEventListener('close', onClose);
      resolve(dialog.returnValue === 'ok' ? input.value.trim() || null : null);
    };
    dialog.addEventListener('close', onClose);
    dialog.showModal();
    input.select();
  });
}

/* ------------------------------------------------------------------ *
 * View, inspector, categories
 * ------------------------------------------------------------------ */

const view = new AtlasView(dom.svg, {
  onSelect: (sel) => select(sel),
  onNodeMoved: () => {
    markDirty();
    refreshChrome();
  },
  onCreateNodeAt: (x, y) => {
    const category = dom.placeCategory.value || state.graph.schema.nodeCategories[0].id;
    const node = addNode(state.graph, { category, x, y });
    markDirty();
    view.rebuild();
    select({ type: 'node', id: node.id });
    toast(`${getNodeCategory(state.graph, category).label} placed.`, 'ok');
  },
  onConnect: (fromId, toId) => {
    try {
      const category = dom.linkCategory.value || state.graph.schema.edgeCategories[0].id;
      const edge = addEdge(state.graph, { from: fromId, to: toId, category });
      markDirty();
      view.rebuild();
      select({ type: 'edge', id: edge.id });
      toast(`${getEdgeCategory(state.graph, category).label} drawn.`, 'ok');
    } catch (err) {
      toast(err.message, 'error');
    }
  },
  onRoute: (fromId, toId) => {
    const route = findRoute(state.graph, fromId, toId, { exclude: ['collapsed_route'] });
    if (!route) {
      view.setRoute(null);
      toast(`No passable route from ${getNode(state.graph, fromId).name} to ${getNode(state.graph, toId).name}.`, 'error');
      return;
    }
    view.setRoute(route);
    const names = route.nodes.map((id) => getNode(state.graph, id).name).join(' → ');
    toast(`${route.edges.length} hop(s), cost ${route.cost}: ${names}`, 'ok');
  },
  onErase: (sel) => {
    if (sel.type === 'node') deleteNode(sel.id);
    else deleteEdge(sel.id);
  },
  onHint: hint,
  onLayoutChanged: () => {
    markDirty();
    refreshChrome();
  },
});

const inspector = new Inspector(dom.inspector, {
  onPatchNode: (id, patch) => {
    try {
      updateNode(state.graph, id, patch);
      markDirty();
      view.rebuild();
      refreshChrome();
      if ('category' in patch || 'parent' in patch) inspector.render(state.graph, state.selection);
    } catch (err) {
      toast(err.message, 'error');
      inspector.render(state.graph, state.selection);
    }
  },
  onPatchEdge: (id, patch) => {
    try {
      updateEdge(state.graph, id, patch);
      markDirty();
      view.rebuild();
      refreshChrome();
      if ('category' in patch || 'from' in patch || 'to' in patch) {
        inspector.render(state.graph, state.selection);
      }
    } catch (err) {
      toast(err.message, 'error');
      inspector.render(state.graph, state.selection);
    }
  },
  onDeleteNode: (id) => deleteNode(id),
  onDeleteEdge: (id) => deleteEdge(id),
  onSelect: (sel) => select(sel),
  onFocusNode: (id) => view.centerOn(id),
  onAddChild: (parentId) => {
    const parent = getNode(state.graph, parentId);
    const worldCat = state.graph.schema.nodeCategories.find((c) => c.id === 'world')
      ?? state.graph.schema.nodeCategories[0];
    const angle = Math.random() * Math.PI * 2;
    const node = addNode(state.graph, {
      category: worldCat.id,
      parent: parentId,
      x: parent.x + Math.cos(angle) * 95,
      y: parent.y + Math.sin(angle) * 95,
    });
    markDirty();
    view.rebuild();
    select({ type: 'node', id: node.id });
  },
});

const categoryManager = new CategoryManager(dom.dlgCategories, {
  onChange: () => {
    markDirty();
    view.rebuild();
    refreshChrome();
    inspector.render(state.graph, state.selection);
    fillCategorySelectors();
  },
  onError: (msg) => toast(msg, 'error'),
  onInfo: (msg) => toast(msg, 'ok'),
});

/* ------------------------------------------------------------------ *
 * Selection / deletion
 * ------------------------------------------------------------------ */

function select(sel) {
  state.selection = sel;
  view.setSelection(sel);
  inspector.render(state.graph, sel);
  if (!sel) {
    dom.statusSelection.textContent = 'nothing selected';
    return;
  }
  if (sel.type === 'node') {
    const node = getNode(state.graph, sel.id);
    const cat = getNodeCategory(state.graph, node?.category);
    dom.statusSelection.textContent = node ? `${cat?.label ?? 'node'}: ${node.name}` : 'nothing selected';
  } else {
    const edge = state.graph.edges.find((e) => e.id === sel.id);
    const cat = getEdgeCategory(state.graph, edge?.category);
    dom.statusSelection.textContent = edge
      ? `${cat?.label ?? 'link'}: ${edge.notes || edge.id}`
      : 'nothing selected';
  }
}

function deleteNode(id) {
  const node = getNode(state.graph, id);
  if (!node) return;
  const result = removeNode(state.graph, id);
  markDirty();
  view.setRoute(null);
  view.rebuild();
  select(null);
  refreshChrome();
  const extra = result.nodes.length - 1;
  toast(`Deleted ${node.name}${extra > 0 ? ` and ${extra} contained node(s)` : ''}.`, 'ok');
}

function deleteEdge(id) {
  const edge = state.graph.edges.find((e) => e.id === id);
  if (!edge) return;
  removeEdge(state.graph, id);
  markDirty();
  view.setRoute(null);
  view.rebuild();
  select(null);
  refreshChrome();
  toast('Highway deleted.', 'ok');
}

/* ------------------------------------------------------------------ *
 * Chrome: legend, stats, title, selectors
 * ------------------------------------------------------------------ */

function markDirty() {
  state.dirty = true;
  dom.statusDirty.textContent = '● unsaved changes';
}

function markClean() {
  state.dirty = false;
  dom.statusDirty.textContent = '';
}

function refreshChrome() {
  const stats = graphStats(state.graph);
  dom.statusStats.textContent =
    `${stats.nodes} nodes · ${stats.edges} links · ${stats.components} cluster(s)`
    + (stats.isolated ? ` · ${stats.isolated} isolated` : '');
  dom.titleLine.textContent = state.file
    ? `${state.graph.meta.title} — ${state.file}`
    : `${state.graph.meta.title} (unsaved)`;
  document.title = `${state.graph.meta.title} · Mezsgye Atlas`;
  drawLegend(stats);
}

function drawLegend(stats) {
  dom.legend.replaceChildren();
  const head = (text) => {
    const h = document.createElement('h3');
    h.textContent = text;
    return h;
  };
  dom.legend.append(head('Nodes'));
  for (const cat of state.graph.schema.nodeCategories) {
    const row = document.createElement('div');
    row.className = 'legend-row';
    row.innerHTML = `<span class="swatch" style="background:${cat.color}"></span>`
      + `<span>${cat.label}</span><span class="legend-count">${stats.byNodeCategory[cat.id] ?? 0}</span>`;
    dom.legend.append(row);
  }
  dom.legend.append(head('Links'));
  for (const cat of state.graph.schema.edgeCategories) {
    const row = document.createElement('div');
    row.className = 'legend-row';
    row.innerHTML = `<span class="swatch line" style="border-top-color:${cat.color};`
      + `border-top-style:${cat.style === 'solid' ? 'solid' : cat.style}"></span>`
      + `<span>${cat.label}</span><span class="legend-count">${stats.byEdgeCategory[cat.id] ?? 0}</span>`;
    dom.legend.append(row);
  }
}

function fillCategorySelectors() {
  const fill = (select, cats, keep) => {
    select.replaceChildren();
    for (const cat of cats) {
      const option = document.createElement('option');
      option.value = cat.id;
      option.textContent = cat.label;
      select.append(option);
    }
    if (keep && cats.some((c) => c.id === keep)) select.value = keep;
  };
  fill(dom.placeCategory, state.graph.schema.nodeCategories, dom.placeCategory.value);
  fill(dom.linkCategory, state.graph.schema.edgeCategories, dom.linkCategory.value);
}

/** Replace the open document. */
function setGraph(graph, { file = null, dirty = false, fit = true } = {}) {
  state.graph = graph;
  state.file = file;
  view.setRoute(null);
  view.setGraph(graph);
  fillCategorySelectors();
  select(null);
  if (dirty) markDirty();
  else markClean();
  refreshChrome();
  if (fit) view.fit();
  dom.search.value = '';
  dom.searchCount.textContent = '';
  view.setFilter('');
}

/* ------------------------------------------------------------------ *
 * File operations
 * ------------------------------------------------------------------ */

async function refreshFileList(selected = state.file) {
  try {
    const graphs = await api.listGraphs();
    dom.fileSelect.replaceChildren();
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '— unsaved —';
    dom.fileSelect.append(none);
    for (const entry of graphs) {
      const option = document.createElement('option');
      option.value = entry.name;
      option.textContent = `${entry.title} (${entry.nodes}n/${entry.edges}l)`;
      dom.fileSelect.append(option);
    }
    dom.fileSelect.value = selected ?? '';
    return graphs;
  } catch (err) {
    toast(`Could not list stored atlases: ${err.message}`, 'error');
    return [];
  }
}

async function saveAs() {
  const suggestion = state.file ?? state.graph.meta.title;
  const name = await askText({
    title: 'Save atlas as',
    label: 'File name',
    value: suggestion,
    note: 'Stored server-side in the data directory. Letters, digits and dashes.',
  });
  if (!name) return;
  await doSave(name);
}

async function doSave(name) {
  try {
    const saved = await api.saveGraph(name, state.graph);
    state.file = saved.name;
    state.graph.meta.modified = saved.graph.meta.modified;
    markClean();
    await refreshFileList(saved.name);
    refreshChrome();
    const warnings = saved.validation?.warnings ?? [];
    toast(`Saved as "${saved.name}".${warnings.length ? ` ${warnings.length} warning(s).` : ''}`, 'ok');
  } catch (err) {
    toast(`Save failed: ${err.message}`, 'error');
  }
}

async function confirmDiscard(action = 'continue') {
  if (!state.dirty) return true;
  return window.confirm(`This atlas has unsaved changes. ${action} anyway?`);
}

async function openStored(name) {
  if (!name) return;
  if (!(await confirmDiscard('Open another atlas'))) {
    dom.fileSelect.value = state.file ?? '';
    return;
  }
  try {
    const { graph, validation } = await api.loadGraph(name);
    setGraph(graph, { file: name });
    await refreshFileList(name);
    if (validation?.warnings?.length) {
      toast(`Opened with ${validation.warnings.length} warning(s): ${validation.warnings[0]}`, 'error');
    } else {
      toast(`Opened "${name}".`, 'ok');
    }
  } catch (err) {
    toast(`Could not open "${name}": ${err.message}`, 'error');
  }
}

function exportFile() {
  const blob = new Blob([serialize(state.graph)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const slug = (state.file ?? state.graph.meta.title ?? 'atlas')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'atlas';
  const a = document.createElement('a');
  a.href = url;
  a.download = `${slug}.atlas.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast('Exported.', 'ok');
}

async function importFile(file) {
  try {
    const text = await file.text();
    const { graph, validation } = deserialize(text);
    if (!validation.ok) {
      toast(`Import rejected: ${validation.errors[0]}`, 'error');
      return;
    }
    setGraph(graph, { file: null, dirty: true });
    toast(
      `Imported ${graph.nodes.length} nodes / ${graph.edges.length} links`
      + `${validation.warnings.length ? ` with ${validation.warnings.length} warning(s)` : ''}. Not yet saved.`,
      'ok',
    );
  } catch (err) {
    toast(`Import failed: ${err.message}`, 'error');
  }
}

/* ------------------------------------------------------------------ *
 * Dialog wiring
 * ------------------------------------------------------------------ */

function wireGenerate() {
  const form = $('#form-generate');
  dom.dlgGenerate.addEventListener('close', async () => {
    if (dom.dlgGenerate.returnValue !== 'ok') return;
    const data = new FormData(form);
    const options = { ...GENERATOR_DEFAULTS };
    for (const [key, raw] of data.entries()) {
      options[key] = key === 'title' ? String(raw) : Number(raw);
    }
    if (!(await confirmDiscard('Generate a new atlas'))) return;
    const graph = generateAtlas(options);
    setGraph(graph, { file: null, dirty: true });
    toast(`Generated ${graph.nodes.length} nodes and ${graph.edges.length} links (seed ${options.seed}).`, 'ok');
  });
  $('#btn-generate').addEventListener('click', () => dom.dlgGenerate.showModal());
}

function wireMeta() {
  const form = $('#form-meta');
  $('#btn-meta').addEventListener('click', () => {
    form.elements.title.value = state.graph.meta.title;
    form.elements.subtitle.value = state.graph.meta.subtitle ?? '';
    form.elements.notes.value = state.graph.meta.notes ?? '';
    dom.dlgMeta.showModal();
  });
  dom.dlgMeta.addEventListener('close', () => {
    if (dom.dlgMeta.returnValue !== 'ok') return;
    state.graph.meta.title = form.elements.title.value.trim() || 'Untitled Atlas';
    state.graph.meta.subtitle = form.elements.subtitle.value;
    state.graph.meta.notes = form.elements.notes.value;
    markDirty();
    refreshChrome();
  });
}

function wireToolbar() {
  for (const button of document.querySelectorAll('.tool')) {
    button.addEventListener('click', () => setTool(button.dataset.tool));
  }
  $('#btn-relax').addEventListener('click', () => {
    view.relax();
    hint('Relaxing layout — pinned nodes stay put');
  });
  const flexBtn = $('#btn-flexible');
  flexBtn.addEventListener('click', () => {
    const on = flexBtn.getAttribute('aria-pressed') !== 'true';
    flexBtn.setAttribute('aria-pressed', String(on));
    view.setFlexible(on);
    hint(on
      ? 'Flexible mode ON — drag any node freely; pin nodes to hold them still'
      : 'Flexible mode OFF — layout frozen');
  });
  $('#btn-fit').addEventListener('click', () => view.fit());
  const labelBtn = $('#btn-labels');
  labelBtn.addEventListener('click', () => {
    const on = labelBtn.getAttribute('aria-pressed') !== 'true';
    labelBtn.setAttribute('aria-pressed', String(on));
    view.setLabels(on);
  });

  const collapseBtn = $('#btn-collapse-all');
  collapseBtn.addEventListener('click', () => {
    // Toggle: if anything is collapsed, expand everything; otherwise collapse
    // every parent node.
    if (view.collapsed.size > 0) {
      const count = view.expandAll();
      collapseBtn.setAttribute('aria-pressed', 'false');
      hint(count ? `Expanded ${count} node(s)` : 'Nothing to expand');
    } else {
      const count = view.collapseAll();
      collapseBtn.setAttribute('aria-pressed', String(count > 0));
      hint(count ? `Collapsed ${count} parent node(s)` : 'No parent nodes to collapse');
    }
  });
}

function setTool(tool) {
  state.tool = tool;
  view.setTool(tool);
  for (const button of document.querySelectorAll('.tool')) {
    button.setAttribute('aria-pressed', String(button.dataset.tool === tool));
  }
  const hints = {
    select: 'Select: drag nodes, drag background to pan, right-click to pin',
    add: `Place: click empty space to add a ${dom.placeCategory.selectedOptions[0]?.textContent ?? 'node'}`,
    connect: 'Link: click two nodes to connect them',
    route: 'Route: click origin then destination for the cheapest path',
    erase: 'Erase: click a node or highway to delete it',
  };
  hint(hints[tool] ?? '');
}

function wireHeader() {
  dom.fileSelect.addEventListener('change', () => {
    const name = dom.fileSelect.value;
    if (name) openStored(name);
    else dom.fileSelect.value = state.file ?? '';
  });
  $('#btn-save').addEventListener('click', () => (state.file ? doSave(state.file) : saveAs()));
  $('#btn-save-as').addEventListener('click', saveAs);
  $('#btn-new').addEventListener('click', async () => {
    if (!(await confirmDiscard('Start a new atlas'))) return;
    setGraph(createEmptyGraph({ title: 'Untitled Atlas', schema: defaultSchema() }), { file: null });
    toast('New empty atlas.', 'ok');
  });
  $('#btn-delete-file').addEventListener('click', async () => {
    const name = dom.fileSelect.value;
    if (!name) {
      toast('No stored atlas selected.', 'error');
      return;
    }
    if (!window.confirm(`Delete the stored atlas "${name}"? This removes the file on disk.`)) return;
    try {
      await api.deleteGraph(name);
      if (state.file === name) state.file = null;
      await refreshFileList(state.file);
      refreshChrome();
      toast(`Deleted "${name}".`, 'ok');
    } catch (err) {
      toast(`Delete failed: ${err.message}`, 'error');
    }
  });

  $('#btn-export').addEventListener('click', exportFile);
  $('#btn-import').addEventListener('click', () => dom.importInput.click());
  dom.importInput.addEventListener('change', async () => {
    const file = dom.importInput.files?.[0];
    dom.importInput.value = '';
    if (!file) return;
    if (!(await confirmDiscard('Import over it'))) return;
    await importFile(file);
  });

  $('#btn-categories').addEventListener('click', () => categoryManager.open(state.graph));

  dom.search.addEventListener('input', () => {
    const query = dom.search.value;
    if (!query.trim()) {
      view.setFilter('');
      dom.searchCount.textContent = '';
      return;
    }
    const count = view.setFilter(query);
    dom.searchCount.textContent = `${count} match${count === 1 ? '' : 'es'}`;
  });
}

function wireKeyboard() {
  window.addEventListener('keydown', (evt) => {
    const target = evt.target;
    const typing = target instanceof HTMLInputElement
      || target instanceof HTMLTextAreaElement
      || target instanceof HTMLSelectElement;

    if (evt.key === 'Escape') {
      if (view.cancelPending()) {
        hint('Cancelled');
        return;
      }
      view.setRoute(null);
      return;
    }
    if ((evt.ctrlKey || evt.metaKey) && evt.key.toLowerCase() === 's') {
      evt.preventDefault();
      if (state.file) doSave(state.file);
      else saveAs();
      return;
    }
    if (typing) return;

    switch (evt.key.toLowerCase()) {
      case 'v': setTool('select'); break;
      case 'a': setTool('add'); break;
      case 'c': setTool('connect'); break;
      case 'r': setTool('route'); break;
      case 'x': setTool('erase'); break;
      case 'f': view.fit(); break;
      case 'l': view.relax(); break;
      case 'g': {
        const flexBtn = $('#btn-flexible');
        const on = flexBtn.getAttribute('aria-pressed') !== 'true';
        flexBtn.setAttribute('aria-pressed', String(on));
        view.setFlexible(on);
        hint(on
          ? 'Flexible mode ON — drag any node freely; pin nodes to hold them still'
          : 'Flexible mode OFF — layout frozen');
        break;
      }
      case 'delete':
      case 'backspace':
        if (state.selection) {
          evt.preventDefault();
          if (state.selection.type === 'node') deleteNode(state.selection.id);
          else deleteEdge(state.selection.id);
        }
        break;
      default: break;
    }
  });

  window.addEventListener('beforeunload', (evt) => {
    if (!state.dirty) return;
    evt.preventDefault();
    evt.returnValue = '';
  });
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

async function boot() {
  wireHeader();
  wireToolbar();
  wireGenerate();
  wireMeta();
  wireKeyboard();

  setGraph(state.graph, { file: null });
  setTool('select');

  const graphs = await refreshFileList(null);
  if (graphs.length) {
    await openStored(graphs[0].name);
  } else {
    // First run: show something rather than an empty void.
    setGraph(generateAtlas({ seed: 7, sectors: 7, title: 'Example Atlas' }), { file: null, dirty: true });
    toast('Example atlas generated. Save it, or press Generate for another.', 'ok');
  }
}

boot().catch((err) => {
  toast(`Startup failed: ${err.message}`, 'error');
  // eslint-disable-next-line no-console
  console.error(err);
});
