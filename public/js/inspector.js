/**
 * Mezsgye Atlas — inspector panel.
 *
 * Renders whatever is selected. Every field shown below the built-ins is driven
 * by the selected item's category definition, so categories and fields added at
 * runtime appear here with no extra code.
 */

import {
  formatDuration,
  getEdge,
  getEdgeCategory,
  getNode,
  getNodeCategory,
  neighborsOf,
  childrenOf,
  nodeColor,
  parseDuration,
} from '/shared/model.js';

/** Debounce helper for text inputs. */
function debounce(fn, ms = 250) {
  let handle = null;
  return (...args) => {
    clearTimeout(handle);
    handle = setTimeout(() => fn(...args), ms);
  };
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== null) node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child) node.append(child);
  }
  return node;
}

export class Inspector {
  /**
   * @param {HTMLElement} container
   * @param {{
   *   onPatchNode: (id: string, patch: object) => void,
   *   onPatchEdge: (id: string, patch: object) => void,
   *   onDeleteNode: (id: string) => void,
   *   onDeleteEdge: (id: string) => void,
   *   onSelect: (sel: {type: string, id: string}|null) => void,
   *   onFocusNode: (id: string) => void,
   *   onAddChild: (parentId: string) => void,
   * }} handlers
   */
  constructor(container, handlers) {
    this.container = container;
    this.h = handlers;
    this.graph = null;
    this.selection = null;
    this.readOnly = false;
  }

  /** In read-only mode values are shown as text and edit actions are hidden. */
  setReadOnly(on) {
    this.readOnly = Boolean(on);
  }

  /**
   * Draw the panel.
   *
   * @param {object} graph
   * @param {{type: 'node'|'edge', id: string}|null} selection
   */
  render(graph, selection) {
    this.graph = graph;
    this.selection = selection;
    this.container.replaceChildren();

    if (!selection && this.readOnly) {
      this.#renderAtlasInfo();
      return;
    }
    if (!selection) {
      this.container.append(
        el('p', { class: 'empty-state', text: 'Click a sector, a world or a highway to inspect it.' }),
        el('p', {
          class: 'empty-state',
          text: 'Place tool adds nodes · Link tool draws highways · Route tool finds the fastest path · '
            + 'Ctrl+Z / Ctrl+Y undo and redo · '
            + 'right-click a node to pin it · double-click a sector to fold its worlds away.',
        }),
      );
      return;
    }

    if (selection.type === 'node') this.#renderNode(getNode(graph, selection.id));
    else this.#renderEdge(getEdge(graph, selection.id));
  }

  /* ----------------------------------------------------------- node */

  #renderNode(node) {
    if (!node) {
      this.container.append(el('p', { class: 'empty-state', text: 'That node is gone.' }));
      return;
    }
    const cat = getNodeCategory(this.graph, node.category);
    const patch = (p) => this.h.onPatchNode(node.id, p);

    this.container.append(this.#head('node', node.name, nodeColor(this.graph, node), cat?.label));
    if (this.readOnly) {
      this.#renderNodeReadOnly(node, cat);
      return;
    }

    const core = el('fieldset', { class: 'insp-group' }, el('legend', { text: 'Identity' }));
    core.append(
      this.#text('Name', node.name, (v) => patch({ name: v })),
      this.#select('Category', node.category,
        this.graph.schema.nodeCategories.map((c) => ({ value: c.id, label: c.label })),
        (v) => patch({ category: v })),
      this.#select('Contained in', node.parent ?? '',
        [{ value: '', label: '— nothing —' }].concat(
          this.graph.nodes
            .filter((n) => n.id !== node.id)
            .map((n) => ({ value: n.id, label: `${n.name} (${getNodeCategory(this.graph, n.category)?.label ?? ''})` })),
        ),
        (v) => patch({ parent: v || null })),
      this.#color(node, cat, (v) => patch({ color: v })),
      this.#checkbox('Pinned (ignored by Relax)', node.pinned, (v) => patch({ pinned: v })),
      el('p', {
        class: 'field-help',
        text: `id ${node.id} · x ${Math.round(node.x)} · y ${Math.round(node.y)}`,
      }),
    );
    this.container.append(core);

    if (cat?.fields?.length) {
      const group = el('fieldset', { class: 'insp-group' }, el('legend', { text: `${cat.label} details` }));
      for (const field of cat.fields) {
        group.append(this.#fieldControl(field, node.data[field.key], (value) => patch({ data: { [field.key]: value } })));
      }
      this.container.append(group);
    }

    const notes = el('fieldset', { class: 'insp-group' }, el('legend', { text: 'Notes' }));
    notes.append(this.#textarea('', node.notes, (v) => patch({ notes: v }), 5));
    this.container.append(notes);

    const kids = this.#contains(node);
    if (kids) this.container.append(kids);

    this.container.append(this.#highways(node));

    this.container.append(el('div', { class: 'insp-actions' }, [
      el('button', { text: 'Add contained node', onclick: () => this.h.onAddChild(node.id) }),
      el('button', { text: 'Centre view', onclick: () => this.h.onFocusNode(node.id) }),
      el('button', { class: 'danger', text: 'Delete node', onclick: () => this.h.onDeleteNode(node.id) }),
    ]));
  }

  /** "Contains" list: navigation, so shared by edit and read-only views. */
  #contains(node) {
    const kids = childrenOf(this.graph, node.id);
    if (!kids.length) return null;
    const group = el('fieldset', { class: 'insp-group' }, el('legend', { text: `Contains (${kids.length})` }));
    group.append(this.#list(kids.map((kid) => ({
      id: kid.id,
      label: kid.name,
      kind: getNodeCategory(this.graph, kid.category)?.label ?? '',
      color: nodeColor(this.graph, kid),
    }))));
    return group;
  }

  /** Links touching a node, with their travel time. */
  #highways(node) {
    const links = neighborsOf(this.graph, node.id);
    const group = el('fieldset', { class: 'insp-group' }, el('legend', { text: `Highways (${links.length})` }));
    if (links.length) {
      const list = el('ul', { class: 'conn-list' });
      for (const { edge, node: other } of links) {
        const ecat = getEdgeCategory(this.graph, edge.category);
        list.append(el('li', {}, [
          el('span', { class: 'swatch line', style: `border-top-color:${ecat?.color ?? '#888'}` }),
          el('button', {
            class: 'link-btn',
            title: 'Inspect this highway',
            text: `${edge.notes || ecat?.label || edge.category} → ${other?.name ?? '?'}`,
            onclick: () => this.h.onSelect({ type: 'edge', id: edge.id }),
          }),
          el('span', {
            class: 'conn-kind',
            text: [ecat?.label ?? '', this.#time(edge, true)].filter(Boolean).join(' · '),
          }),
        ]));
      }
      group.append(list);
    } else {
      group.append(el('p', {
        class: 'field-help',
        text: this.readOnly ? 'Nothing connects here.' : 'Nothing connects here yet. Use the Link tool.',
      }));
    }
    return group;
  }

  /** Formatted travel time of an edge, or '' when it has none. */
  #time(edge, compact = false) {
    const hours = edge?.data?.cost;
    if (hours === undefined || hours === null || hours === '') return '';
    return formatDuration(hours, { compact });
  }

  /* ------------------------------------------------------ read-only */

  /** Atlas title and notes, shown when nothing is selected in read-only mode. */
  #renderAtlasInfo() {
    const meta = this.graph?.meta ?? {};
    const box = el('div', { class: 'ro-meta' }, [el('h2', { text: meta.title || 'Untitled Atlas' })]);
    if (meta.subtitle) box.append(el('p', { class: 'ro-sub', text: meta.subtitle }));
    if (meta.notes) box.append(el('p', { class: 'ro-notes', text: meta.notes }));
    this.container.append(
      box,
      el('p', {
        class: 'empty-state',
        text: 'Read-only view. Click anything to read about it · Route tool (R) finds the fastest path · '
          + 'drag nodes to look around (moves are not saved).',
      }),
    );
  }

  #renderNodeReadOnly(node, cat) {
    const parent = node.parent ? getNode(this.graph, node.parent) : null;
    const core = el('fieldset', { class: 'insp-group' }, el('legend', { text: 'Identity' }));
    core.append(this.#show('Category', cat?.label ?? node.category));
    if (parent) {
      core.append(this.#show('Contained in', el('button', {
        class: 'link-btn',
        text: parent.name,
        onclick: () => this.h.onSelect({ type: 'node', id: parent.id }),
      })));
    }
    this.container.append(core);

    const details = this.#readOnlyFields(cat, node.data);
    if (details) this.container.append(details);
    if (node.notes?.trim()) {
      const notes = el('fieldset', { class: 'insp-group' }, el('legend', { text: 'Notes' }));
      notes.append(el('div', { class: 'ro-value', text: node.notes }));
      this.container.append(notes);
    }
    const kids = this.#contains(node);
    if (kids) this.container.append(kids);
    this.container.append(this.#highways(node));
    this.container.append(el('div', { class: 'insp-actions' }, [
      el('button', { text: 'Centre view', onclick: () => this.h.onFocusNode(node.id) }),
    ]));
  }

  #renderEdgeReadOnly(edge, cat, from, to) {
    const core = el('fieldset', { class: 'insp-group' }, el('legend', { text: 'Route' }));
    core.append(this.#show('Category', cat?.label ?? edge.category));
    const go = (n) => (n
      ? el('button', { class: 'link-btn', text: n.name, onclick: () => this.h.onSelect({ type: 'node', id: n.id }) })
      : '?');
    core.append(this.#show('From', go(from)), this.#show('To', go(to)));
    this.container.append(core);
    const details = this.#readOnlyFields(cat, edge.data);
    if (details) this.container.append(details);
  }

  /** Category fields that have a value, as label/value rows. */
  #readOnlyFields(cat, data) {
    const rows = [];
    for (const field of cat?.fields ?? []) {
      const text = this.#display(field, data?.[field.key]);
      if (text) rows.push(this.#show(field.label, text));
    }
    if (!rows.length) return null;
    const group = el('fieldset', { class: 'insp-group' }, el('legend', { text: `${cat.label} details` }));
    group.append(...rows);
    return group;
  }

  /** Human text for a stored field value; '' when there is nothing to show. */
  #display(field, value) {
    if (value === undefined || value === null || value === '') return '';
    switch (field.type) {
      case 'duration': return formatDuration(value);
      case 'boolean': return value ? 'yes' : 'no';
      case 'tags': return Array.isArray(value) ? value.join(', ') : String(value);
      default: return String(value);
    }
  }

  /** One read-only label/value row. `value` is text or an element. */
  #show(label, value) {
    const out = el('div', { class: 'ro-value' });
    if (typeof value === 'string') out.textContent = value;
    else out.append(value);
    return el('div', { class: 'ro-field' }, [el('span', { class: 'ro-label', text: label }), out]);
  }

  /* ----------------------------------------------------------- edge */

  #renderEdge(edge) {
    if (!edge) {
      this.container.append(el('p', { class: 'empty-state', text: 'That highway is gone.' }));
      return;
    }
    const cat = getEdgeCategory(this.graph, edge.category);
    const from = getNode(this.graph, edge.from);
    const to = getNode(this.graph, edge.to);
    const patch = (p) => this.h.onPatchEdge(edge.id, p);

    this.container.append(this.#head('highway', edge.notes || cat?.label || edge.id, cat?.color, cat?.label));
    if (this.readOnly) {
      this.#renderEdgeReadOnly(edge, cat, from, to);
      return;
    }

    const core = el('fieldset', { class: 'insp-group' }, el('legend', { text: 'Route' }));
    const nodeOptions = this.graph.nodes.map((n) => ({ value: n.id, label: n.name }));
    core.append(
      this.#text('Name', edge.notes, (v) => patch({ notes: v })),
      this.#select('Category', edge.category,
        this.graph.schema.edgeCategories.map((c) => ({ value: c.id, label: c.label })),
        (v) => patch({ category: v })),
      this.#select('From', edge.from, nodeOptions, (v) => patch({ from: v })),
      this.#select('To', edge.to, nodeOptions, (v) => patch({ to: v })),
      el('p', { class: 'field-help', text: `id ${edge.id}` }),
    );
    this.container.append(core);

    if (cat?.fields?.length) {
      const group = el('fieldset', { class: 'insp-group' }, el('legend', { text: `${cat.label} details` }));
      for (const field of cat.fields) {
        group.append(this.#fieldControl(field, edge.data[field.key], (value) => patch({ data: { [field.key]: value } })));
      }
      this.container.append(group);
    }

    this.container.append(el('div', { class: 'insp-actions' }, [
      el('button', {
        text: 'Swap direction',
        onclick: () => this.h.onPatchEdge(edge.id, { from: edge.to, to: edge.from }),
      }),
      from && el('button', { text: `Go to ${from.name}`, onclick: () => this.h.onSelect({ type: 'node', id: from.id }) }),
      to && el('button', { text: `Go to ${to.name}`, onclick: () => this.h.onSelect({ type: 'node', id: to.id }) }),
      el('button', { class: 'danger', text: 'Delete highway', onclick: () => this.h.onDeleteEdge(edge.id) }),
    ].filter(Boolean)));
  }

  /* -------------------------------------------------------- widgets */

  #head(kind, title, color, catLabel) {
    return el('div', { class: 'insp-head' }, [
      el('span', { class: 'insp-dot', style: `background:${color ?? '#888'}` }),
      el('div', {}, [
        el('div', { class: 'insp-kind', text: `${kind}${catLabel ? ` · ${catLabel}` : ''}` }),
        el('h2', { text: title || '(unnamed)' }),
      ]),
    ]);
  }

  /**
   * Build the right control for a schema field.
   *
   * @param {{key: string, label: string, type: string, options?: string[], help?: string}} field
   * @param {any} value
   * @param {(value: any) => void} commit
   */
  #fieldControl(field, value, commit) {
    switch (field.type) {
      case 'textarea':
        return this.#textarea(field.label, value ?? '', commit, 4, field.help);
      case 'number':
        return this.#number(field.label, value, commit, field.help);
      case 'duration':
        return this.#duration(field.label, value, commit, field.help);
      case 'boolean':
        return this.#checkbox(field.label, Boolean(value), commit, field.help);
      case 'select':
        return this.#select(
          field.label,
          value ?? '',
          [{ value: '', label: '—' }].concat((field.options ?? []).map((o) => ({ value: o, label: o }))),
          commit,
          field.help,
        );
      case 'tags':
        return this.#tags(field.label, Array.isArray(value) ? value : [], commit, field.help);
      default:
        return this.#text(field.label, value ?? '', commit, field.help);
    }
  }

  #wrap(labelText, control, help, extraClass = '') {
    const label = el('label', { class: `field ${extraClass}`.trim() });
    if (labelText) label.append(el('span', { text: labelText }));
    label.append(control);
    if (help) label.append(el('span', { class: 'field-help', text: help }));
    return label;
  }

  #text(labelText, value, commit, help) {
    const input = el('input', { type: 'text', value: value ?? '' });
    input.addEventListener('input', debounce(() => commit(input.value)));
    input.addEventListener('change', () => commit(input.value));
    return this.#wrap(labelText, input, help);
  }

  #number(labelText, value, commit, help) {
    const input = el('input', { type: 'number', value: value ?? '', step: 'any' });
    const send = () => {
      const num = Number(input.value);
      commit(input.value === '' ? null : (Number.isFinite(num) ? num : 0));
    };
    input.addEventListener('input', debounce(send));
    input.addEventListener('change', send);
    return this.#wrap(labelText, input, help);
  }

  /**
   * Travel time: type "36h", "2d 6h", "1 month"; stored as hours. The help
   * line shows how the value was understood, or why it was not.
   */
  #duration(labelText, value, commit, help) {
    const input = el('input', {
      type: 'text',
      value: formatDuration(value),
      placeholder: 'e.g. 36h, 2d 6h, 1 month',
      autocomplete: 'off',
    });
    const feedback = el('span', { class: 'field-help' });
    const describe = (hours) => {
      feedback.textContent = hours === null || hours === undefined || hours === ''
        ? (help ?? '')
        : `= ${Number(hours)} hours${help ? ` · ${help}` : ''}`;
    };
    describe(value);
    const read = () => {
      const raw = input.value.trim();
      if (!raw) {
        input.removeAttribute('aria-invalid');
        describe(null);
        return { ok: true, hours: null };
      }
      const hours = parseDuration(raw);
      if (hours === null) {
        input.setAttribute('aria-invalid', 'true');
        feedback.textContent = 'Not understood — use hours (h), days (d), weeks (w) or months (mo).';
        return { ok: false };
      }
      input.removeAttribute('aria-invalid');
      describe(hours);
      return { ok: true, hours };
    };
    input.addEventListener('input', read);
    input.addEventListener('change', () => {
      const result = read();
      if (!result.ok) return;
      commit(result.hours);
      if (result.hours !== null) input.value = formatDuration(result.hours);
    });
    const label = el('label', { class: 'field' }, [el('span', { text: labelText }), input, feedback]);
    return label;
  }

  /** Per-node colour override, with a reset back to the category colour. */
  #color(node, cat, commit) {
    const fallback = cat?.color ?? '#8b6cff';
    const input = el('input', { type: 'color', value: node.color ?? fallback, title: 'Node colour' });
    input.addEventListener('change', () => commit(input.value));
    const reset = el('button', {
      type: 'button',
      class: 'small',
      text: 'Use category colour',
      title: `Reset to the ${cat?.label ?? 'category'} colour`,
      onclick: () => commit(null),
    });
    if (!node.color) reset.disabled = true;
    const state = el('span', {
      class: 'field-help',
      text: node.color ? 'Custom colour' : `Category default (${cat?.label ?? ''})`,
    });
    return el('div', { class: 'field color-field' }, [
      el('span', { text: 'Colour' }),
      el('div', { class: 'color-row' }, [input, reset]),
      state,
    ]);
  }

  #textarea(labelText, value, commit, rows = 4, help) {
    const input = el('textarea', { rows });
    input.value = value ?? '';
    input.addEventListener('input', debounce(() => commit(input.value), 350));
    input.addEventListener('change', () => commit(input.value));
    return this.#wrap(labelText, input, help);
  }

  #checkbox(labelText, value, commit, help) {
    const input = el('input', { type: 'checkbox' });
    input.checked = Boolean(value);
    input.addEventListener('change', () => commit(input.checked));
    const label = el('label', { class: 'field inline' }, [input, el('span', { text: labelText })]);
    if (help) label.append(el('span', { class: 'field-help', text: help }));
    return label;
  }

  #select(labelText, value, options, commit, help) {
    const select = el('select');
    for (const opt of options) {
      const option = el('option', { value: opt.value, text: opt.label });
      if (String(opt.value) === String(value)) option.selected = true;
      select.append(option);
    }
    select.addEventListener('change', () => commit(select.value));
    return this.#wrap(labelText, select, help);
  }

  #tags(labelText, values, commit, help) {
    const row = el('div', { class: 'tag-row' });
    const redraw = () => {
      row.replaceChildren();
      values.forEach((tag, i) => {
        row.append(el('span', { class: 'tag' }, [
          document.createTextNode(tag),
          el('button', {
            type: 'button',
            title: `Remove ${tag}`,
            text: '✕',
            onclick: () => {
              const next = values.filter((_, j) => j !== i);
              commit(next);
            },
          }),
        ]));
      });
    };
    redraw();

    const input = el('input', { type: 'text', placeholder: 'add and press Enter' });
    input.addEventListener('keydown', (evt) => {
      if (evt.key !== 'Enter') return;
      evt.preventDefault();
      const tag = input.value.trim();
      if (!tag) return;
      input.value = '';
      commit([...values, tag]);
    });

    const label = el('label', { class: 'field' }, [
      el('span', { text: labelText }),
      input,
      row,
    ]);
    if (help) label.append(el('span', { class: 'field-help', text: help }));
    return label;
  }

  #list(items) {
    const list = el('ul', { class: 'conn-list' });
    for (const item of items) {
      list.append(el('li', {}, [
        el('span', { class: 'swatch', style: `background:${item.color ?? '#888'}` }),
        el('button', {
          class: 'link-btn',
          text: item.label,
          onclick: () => this.h.onSelect({ type: 'node', id: item.id }),
        }),
        el('span', { class: 'conn-kind', text: item.kind }),
      ]));
    }
    return list;
  }
}
