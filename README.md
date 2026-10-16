# Mezsgye Atlas

A local web app for drawing, inspecting and exporting the sector maps of the
Mezsgye setting: **sectors** linked by **essence streets** (the highways that
void makers ride), with **worlds** nested inside sectors, plus waystations and
anomalies.

Zero runtime dependencies — plain Node.js (`node:http`) on the server, plain
ES modules and SVG in the browser. No build step.

---

## Running it

```bash
node server.js            # http://127.0.0.1:7311
npm start                 # the same
npm run dev               # with --watch
npm test                  # 74 tests, node:test
```

Requires Node 20+ (tested on 22). Without a local Node 20+, run the tests in
Docker:

```bash
docker run --rm -v "$PWD":/app:ro -w /app node:22-alpine node --test "test/**/*.test.js"
```

In Docker:

```bash
docker build -t mezsgye-atlas .
docker run --rm -p 127.0.0.1:7311:7311 -v "$PWD/data:/data" mezsgye-atlas
```

Environment:

| Variable     | Default           | Meaning                        |
| ------------ | ----------------- | ------------------------------ |
| `PORT`       | `7311`            | listening port                 |
| `HOST`       | `127.0.0.1`       | bind address                   |
| `ATLAS_DATA` | `./data`          | where atlas files are stored   |

### Security note

**There is no authentication.** Anyone who can reach the port can read, edit
and delete every stored atlas. The server binds to `127.0.0.1` by default for
that reason. If you expose it (`HOST=0.0.0.0`, or the Docker image's default),
put it behind a reverse proxy that authenticates, or restrict it to a trusted
network. The file API also only ever writes inside `ATLAS_DATA`: names are
reduced to a `[a-z0-9-]` slug and the resolved path is re-checked, so
`../../etc/passwd` becomes the file `etc-passwd.atlas.json`.

---

## Using it

The map is an SVG canvas: drag the background to pan, scroll to zoom.

**Tools** (left rail, with keyboard shortcuts):

| Tool       | Key | What it does                                                |
| ---------- | --- | ----------------------------------------------------------- |
| Select     | `V` | click to inspect, drag to move (dragging pins the node)     |
| Place      | `A` | click empty space to add a node of the chosen category      |
| Link       | `C` | click two nodes to draw a highway of the chosen category    |
| Route      | `R` | click origin then destination — fastest path is highlighted  |
| Erase      | `X` | click a node or highway to delete it                        |

Other keys: `F` fit to view, `L` relax the layout, `G` flexible mode, `Delete`
removes the selection, `Esc` cancels a pending link/route, `Ctrl+S` saves,
`Ctrl+Z` undoes, `Ctrl+Y` (or `Ctrl+Shift+Z`) redoes.

**Undo / Redo** (toolbar buttons or the keys above) cover every edit: placing,
linking, deleting, moving, inspector changes, category changes and atlas info.
Typing into one field counts as a single step. Undoing back to the last saved
state clears the "unsaved changes" flag. Opening, importing or generating an
atlas starts a fresh history.

Also: right-click a node to pin/unpin it (pinned nodes are ignored by Relax),
double-click a sector to fold its worlds away, and use the badge on a sector to
do the same with the mouse.

Clicking anything fills the **inspector** on the right: name, category,
colour, containment, every custom field for that category, free-text notes, the
list of contained nodes, and the list of highways touching it (each clickable,
with its travel time).

**Node colour:** each node is drawn in its category's colour by default. Pick a
different colour in the inspector to override it for that one node; **Use
category colour** removes the override. A node without an override follows any
later change to its category's colour.

### Travel time and routes

Every link has a single **Travel time**, stored as hours. Type it however is
convenient — `36`, `36h`, `2d 6h`, `1 week`, `1 month 3 days`, or Hungarian
(`1,5 nap`, `2 hónap`) — and it is shown as months / days / hours
(1 day = 24 hours, 1 month = 30 days). The help line under the field shows how
the value was read, and turns red when it cannot be understood.

The **Route** tool uses these hours to find the fastest path and reports the
total, e.g. `3 hop(s), 7 days 12 hours total`. Collapsed routes are never used.

### Read-only view

Add `?readonly` to the address — `http://127.0.0.1:7311/?readonly` — for a
view-only page, e.g. to show players the map. Editing tools, Save, Import,
Generate, Categories, Undo and the edit inspector are hidden; the inspector
shows values as text instead. You can still open stored atlases, pan, zoom,
search, plot routes, collapse/expand and export. Nodes can be dragged and the
layout relaxed to look around, but such moves are never saved.

This is a convenience, **not access control**: it only changes what this page
offers. Anyone who can reach the server can remove `?readonly` or call the API
directly — see the security note above.

The search box filters by name, category or any field value; non-matches dim.

### Files

- **Save / Save as** — writes a named file into the server's data directory.
  The dropdown lists everything stored there; picking one opens it.
- **Export** — downloads the atlas as `<name>.atlas.json`.
- **Import** — reads such a file back. Imported documents are validated and
  repaired (dangling links dropped, unknown categories remapped) before use.
- **Delete file** — removes the stored file on disk.

Unsaved changes are flagged in the status bar and warned about on navigation.

### Generating a map

**Generate…** builds a connected sector network from a seed: sectors on a ring,
a random spanning tree of essence streets so nothing is stranded, extra loops
and minor currents, worlds nested in each sector, plus optional waystations and
anomalies. Names are Hungarian-flavoured compounds (*Ködrév*, *Szélhalom*,
*Törött Vasfolyam*, worlds like *Ködrév II* or *Vén Hamu*). Street travel
times run from a few hours to about ten days; minor currents from a day to two
months. The same seed always yields the same atlas.

---

## Categories are expandable

Nothing about "sector" or "essence street" is hard-coded in the UI. A category
declares its own colour, glyph/line style and list of fields, and everything
else is generated from that.

**Categories…** lets you:

- add a node or link category (colour, shape or line style, size/width);
- add fields to any category — types `text`, `textarea`, `number`,
  `duration` (hours, entered and shown as months/days/hours), `boolean`,
  `select` (with options), `tags`;
- rename a field's key (stored values migrate), retype it, or change defaults;
- remove a field (values are purged) or a category (items get reassigned to
  another category you pick).

Adding a field back-fills its default onto every existing item of that
category, so old atlases pick up new fields cleanly. The schema travels inside
the document, so an exported atlas carries its own categories with it.

Ships with: sectors, worlds, waystations, anomalies; essence streets, minor
currents, collapsed routes.

---

## Data format

One JSON document per atlas:

```jsonc
{
  "schemaVersion": 2,
  "meta": { "title": "…", "subtitle": "…", "notes": "…", "created": "…", "modified": "…" },
  "schema": {
    "nodeCategories": [
      { "id": "sector", "label": "Sector", "color": "#8b6cff", "shape": "hex", "size": 26,
        "fields": [ { "key": "essence_density", "label": "Essence density",
                      "type": "select", "options": ["dead","thin","stable","rich","volatile"],
                      "default": "stable" } ] }
    ],
    "edgeCategories": [
      { "id": "essence_street", "label": "Essence street", "color": "#8b6cff",
        "style": "solid", "width": 3.5,
        "fields": [ { "key": "cost", "label": "Travel time", "type": "duration", "default": 24 } ] }
    ]
  },
  "nodes": [
    { "id": "n1", "name": "Ködrév", "category": "sector", "x": 0, "y": 0,
      "pinned": false, "parent": null, "color": null,
      "data": { "essence_density": "rich" }, "notes": "" }
  ],
  "edges": [
    { "id": "e1", "from": "n1", "to": "n2", "category": "essence_street",
      "data": { "cost": 54 }, "notes": "Csendút" }
  ]
}
```

`parent` is containment (a world inside a sector), drawn as a faint tether.
`color` is an optional per-node override (`#rrggbb`); `null` means "use the
category colour". `edges` are routes; `data.cost` is the travel time in hours
(54 = 2 days 6 hours) and drives the Route tool's Dijkstra search. Collapsed
routes are excluded from it.

**Older files (`schemaVersion` 1)** are migrated when opened: the separate
"Travel cost" number and "Travel time" text are merged into the one hour-based
field. Readable text such as `5 days` becomes `120`; otherwise the old cost
number is kept as hours, and unreadable text (`3 watches`) is copied into the
link's description so nothing is lost. The file on disk is only rewritten when
you save.

---

## HTTP API

| Method   | Path                 | Purpose                                      |
| -------- | -------------------- | -------------------------------------------- |
| `GET`    | `/api/health`        | liveness, data directory                     |
| `GET`    | `/api/schema`        | default schema + generator defaults          |
| `GET`    | `/api/graphs`        | list stored atlases                          |
| `POST`   | `/api/graphs`        | `{name, graph?}` create (409 if it exists)   |
| `GET`    | `/api/graphs/:name`  | load one (normalised, with a validation report) |
| `PUT`    | `/api/graphs/:name`  | `{graph}` save; 422 with a report if invalid |
| `DELETE` | `/api/graphs/:name`  | delete the file                              |
| `POST`   | `/api/validate`      | `{graph}` → `{ok, errors, warnings}`         |
| `POST`   | `/api/generate`      | generator options → a graph (not saved)      |

Handy for scripting a map from the command line:

```bash
curl -s -X POST localhost:7311/api/generate \
     -H 'content-type: application/json' \
     -d '{"seed":42,"sectors":12,"title":"Deep Void"}' \
  | python3 -c 'import json,sys; print(json.dumps({"graph": json.load(sys.stdin)["graph"]}))' \
  | curl -s -X PUT localhost:7311/api/graphs/deep-void \
         -H 'content-type: application/json' --data-binary @- > /dev/null
```

---

## Layout

```
server.js              node:http static server + JSON API
src/model.js           the whole data model: CRUD, validation, schema mutation, routing, travel time
src/layout.js          force-layout step used by Relax and Flexible mode
src/history.js         undo/redo snapshot history
src/generate.js        seeded sector-map generator
src/names.js           Hungarian-flavoured name parts
src/storage.js         atomic file persistence, name sanitising (server only)
public/index.html      app shell
public/css/style.css   styling
public/js/app.js       state, file operations, toolbar, keyboard, undo, read-only mode
public/js/graph.js     SVG rendering, pan/zoom, picking, dragging, force relaxation
public/js/inspector.js schema-driven detail panel (edit and read-only views)
public/js/categories.js category & field manager
public/js/api.js       fetch wrapper
test/                  node:test suites (model, generate, layout, history, storage, api)
```

`src/model.js`, `src/layout.js`, `src/history.js`, `src/generate.js` and
`src/names.js` are imported by *both* sides — the server mounts `src/` at
`/shared/`, so the browser runs the same validation and mutation code the API
does.
