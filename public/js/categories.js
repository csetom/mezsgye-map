/**
 * Mezsgye Atlas — category manager dialog.
 *
 * The expandable half of the data model: add or edit node/link categories, and
 * add, rename, retype or remove the custom fields each category carries. Edits
 * are applied straight to the open graph document through the model's schema
 * mutators, which also back-fill or migrate stored values.
 */

import {
  EDGE_STYLES,
  FIELD_TYPES,
  NODE_SHAPES,
  addEdgeCategory,
  addField,
  addNodeCategory,
  countUsage,
  formatDuration,
  parseDuration,
  removeCategory,
  removeField,
  updateCategory,
  updateField,
} from '/shared/model.js';

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== null) node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
}

export class CategoryManager {
  /**
   * @param {HTMLDialogElement} dialog
   * @param {{onChange: () => void, onError: (msg: string) => void, onInfo: (msg: string) => void}} handlers
   */
  constructor(dialog, handlers) {
    this.dialog = dialog;
    this.body = dialog.querySelector('#cat-body');
    this.h = handlers;
    this.kind = 'node';
    this.graph = null;

    for (const tab of dialog.querySelectorAll('.tab')) {
      tab.addEventListener('click', () => {
        this.kind = tab.dataset.kind;
        for (const other of dialog.querySelectorAll('.tab')) {
          other.setAttribute('aria-pressed', String(other === tab));
        }
        this.draw();
      });
    }
    dialog.querySelector('#cat-close').addEventListener('click', () => this.dialog.close());
  }

  /** Open the dialog against a graph document. */
  open(graph) {
    this.graph = graph;
    this.draw();
    if (!this.dialog.open) this.dialog.showModal();
  }

  /** Run a mutator, report failures, refresh on success. */
  #apply(fn, successMessage) {
    try {
      fn();
      this.h.onChange();
      if (successMessage) this.h.onInfo(successMessage);
      this.draw();
    } catch (err) {
      this.h.onError(err.message);
    }
  }

  /** Render the current tab. */
  draw() {
    const kind = this.kind;
    const list = kind === 'node' ? this.graph.schema.nodeCategories : this.graph.schema.edgeCategories;
    this.body.replaceChildren();

    for (const cat of list) {
      this.body.append(this.#card(cat, kind, list));
    }

    this.body.append(el('div', { class: 'insp-actions' }, [
      el('button', {
        class: 'primary',
        text: kind === 'node' ? '+ New node category' : '+ New link category',
        onclick: () => {
          const label = window.prompt(`Name for the new ${kind === 'node' ? 'node' : 'link'} category:`);
          if (!label) return;
          this.#apply(() => {
            if (kind === 'node') {
              addNodeCategory(this.graph, {
                label,
                color: '#8b6cff',
                shape: 'circle',
                size: 18,
                fields: [{ key: 'description', label: 'Description', type: 'textarea' }],
              });
            } else {
              addEdgeCategory(this.graph, {
                label,
                color: '#8b6cff',
                style: 'solid',
                width: 2.5,
                fields: [
                  {
                    key: 'cost',
                    label: 'Travel time',
                    type: 'duration',
                    default: 24,
                    help: 'Used by the Route tool. e.g. 36h, 2d 6h, 1 month.',
                  },
                  { key: 'description', label: 'Description', type: 'textarea' },
                ],
              });
            }
          }, `Category "${label}" added.`);
        },
      }),
    ]));
  }

  #card(cat, kind, list) {
    const usage = countUsage(this.graph, kind, cat.id);
    const card = el('div', { class: 'cat-card' });

    card.append(el('header', {}, [
      el('span', { class: 'swatch', style: `background:${cat.color}` }),
      el('strong', { text: cat.label }),
      el('code', { text: cat.id, style: 'color:#6e6a85;font-size:10.5px' }),
      el('span', { class: 'usage', text: `${usage} in use` }),
      el('button', {
        class: 'danger',
        text: 'Remove',
        title: usage ? 'Items will be reassigned' : 'Remove this category',
        onclick: () => {
          if (list.length === 1) {
            this.h.onError('This is the last category of its kind; it cannot be removed.');
            return;
          }
          let reassign = null;
          if (usage > 0) {
            const others = list.filter((c) => c.id !== cat.id);
            const answer = window.prompt(
              `"${cat.label}" is used by ${usage} item(s).\n`
              + `Reassign them to which category?\n\n${others.map((c) => `${c.id} — ${c.label}`).join('\n')}`,
              others[0].id,
            );
            if (!answer) return;
            reassign = answer.trim();
          } else if (!window.confirm(`Remove the "${cat.label}" category?`)) {
            return;
          }
          this.#apply(() => removeCategory(this.graph, kind, cat.id, reassign), `Removed "${cat.label}".`);
        },
      }),
    ]));

    const grid = el('div', { class: 'cat-grid' });
    grid.append(this.#input('Label', 'text', cat.label, (v) => this.#apply(() => updateCategory(this.graph, kind, cat.id, { label: v }))));
    grid.append(this.#input('Colour', 'color', cat.color, (v) => this.#apply(() => updateCategory(this.graph, kind, cat.id, { color: v }))));
    if (kind === 'node') {
      grid.append(this.#choice('Shape', NODE_SHAPES, cat.shape, (v) => this.#apply(() => updateCategory(this.graph, kind, cat.id, { shape: v }))));
      grid.append(this.#input('Size', 'number', cat.size, (v) => this.#apply(() => updateCategory(this.graph, kind, cat.id, { size: Number(v) }))));
    } else {
      grid.append(this.#choice('Line style', EDGE_STYLES, cat.style, (v) => this.#apply(() => updateCategory(this.graph, kind, cat.id, { style: v }))));
      grid.append(this.#input('Line width', 'number', cat.width, (v) => this.#apply(() => updateCategory(this.graph, kind, cat.id, { width: Number(v) }))));
    }
    card.append(grid);
    card.append(this.#input('Description', 'text', cat.description ?? '', (v) => this.#apply(() => updateCategory(this.graph, kind, cat.id, { description: v }))));

    card.append(this.#fieldTable(cat, kind));
    return card;
  }

  #fieldTable(cat, kind) {
    const table = el('table', { class: 'fields' });
    table.append(el('thead', {}, el('tr', {}, [
      el('th', { text: 'Label' }),
      el('th', { text: 'Key' }),
      el('th', { text: 'Type' }),
      el('th', { text: 'Options / default' }),
      el('th', { text: '' }),
    ])));

    const body = el('tbody');
    for (const field of cat.fields) {
      const labelInput = el('input', { type: 'text', value: field.label });
      labelInput.addEventListener('change', () => this.#apply(
        () => updateField(this.graph, kind, cat.id, field.key, { label: labelInput.value }),
      ));

      const keyInput = el('input', { type: 'text', value: field.key });
      keyInput.addEventListener('change', () => this.#apply(
        () => updateField(this.graph, kind, cat.id, field.key, { key: keyInput.value }),
        'Field key renamed; stored values migrated.',
      ));

      const typeSelect = el('select');
      for (const type of FIELD_TYPES) {
        const option = el('option', { value: type, text: type });
        if (type === field.type) option.selected = true;
        typeSelect.append(option);
      }
      typeSelect.addEventListener('change', () => this.#apply(
        () => updateField(this.graph, kind, cat.id, field.key, { type: typeSelect.value }),
      ));

      let detail;
      if (field.type === 'select') {
        const optionsInput = el('input', {
          type: 'text',
          value: (field.options ?? []).join(', '),
          placeholder: 'comma separated',
        });
        optionsInput.addEventListener('change', () => this.#apply(() => updateField(
          this.graph, kind, cat.id, field.key,
          { options: optionsInput.value.split(',').map((s) => s.trim()).filter(Boolean) },
        )));
        detail = optionsInput;
      } else {
        const defaultInput = el('input', {
          type: field.type === 'number' ? 'number' : 'text',
          value: field.type === 'duration' ? formatDuration(field.default) : (field.default ?? ''),
          placeholder: field.type === 'duration' ? 'default, e.g. 2d 6h' : 'default',
        });
        defaultInput.addEventListener('change', () => this.#apply(() => {
          let value;
          if (field.type === 'number') value = Number(defaultInput.value);
          else if (field.type === 'boolean') value = defaultInput.value === 'true';
          else if (field.type === 'duration') {
            value = parseDuration(defaultInput.value);
            if (value === null) throw new Error('Default travel time not understood — try 36h, 2d 6h or 1 month.');
          } else value = defaultInput.value;
          updateField(this.graph, kind, cat.id, field.key, { default: value });
        }));
        detail = defaultInput;
      }

      body.append(el('tr', {}, [
        el('td', {}, labelInput),
        el('td', {}, keyInput),
        el('td', {}, typeSelect),
        el('td', {}, detail),
        el('td', {}, el('button', {
          class: 'danger',
          text: '✕',
          title: 'Remove this field and its stored values',
          onclick: () => {
            if (!window.confirm(`Remove field "${field.label}" and its values from every ${cat.label}?`)) return;
            this.#apply(() => removeField(this.graph, kind, cat.id, field.key), 'Field removed.');
          },
        })),
      ]));
    }

    // "Add field" row.
    const newLabel = el('input', { type: 'text', placeholder: 'New field label' });
    const newType = el('select');
    for (const type of FIELD_TYPES) newType.append(el('option', { value: type, text: type }));
    const newOptions = el('input', { type: 'text', placeholder: 'options, comma separated' });
    const addBtn = el('button', {
      text: '+ Add',
      onclick: () => {
        const label = newLabel.value.trim();
        if (!label) {
          this.h.onError('Give the new field a label.');
          return;
        }
        const spec = { label, key: label, type: newType.value };
        if (newType.value === 'select') {
          spec.options = newOptions.value.split(',').map((s) => s.trim()).filter(Boolean);
        }
        this.#apply(() => addField(this.graph, kind, cat.id, spec), `Field "${label}" added to ${cat.label}.`);
      },
    });
    body.append(el('tr', { class: 'add-field-row' }, [
      el('td', {}, newLabel),
      el('td', { text: 'auto' }),
      el('td', {}, newType),
      el('td', {}, newOptions),
      el('td', {}, addBtn),
    ]));

    table.append(body);
    return table;
  }

  #input(label, type, value, commit) {
    const input = el('input', { type, value: value ?? '' });
    input.addEventListener('change', () => commit(input.value));
    return el('label', {}, [document.createTextNode(label), input]);
  }

  #choice(label, options, value, commit) {
    const select = el('select');
    for (const option of options) {
      const opt = el('option', { value: option, text: option });
      if (option === value) opt.selected = true;
      select.append(opt);
    }
    select.addEventListener('change', () => commit(select.value));
    return el('label', {}, [document.createTextNode(label), select]);
  }
}
