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
npm test                  # 55 tests, node:test
```

Requires Node 20+ (tested on 22).

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
| Route      | `R` | click origin then destination — cheapest path is highlighted |
| Erase      | `X` | click a node or highway to delete it                        |

Other keys: `F` fit to view, `L` relax the layout, `Delete` removes the
selection, `Esc` cancels a pending link/route, `Ctrl+S` saves.

Also: right-click a node to pin/unpin it (pinned nodes are ignored by Relax),
double-click a sector to fold its worlds away, and use the badge on a sector to
do the same with the mouse.

Clicking anything fills the **inspector** on the right: name, category,
containment, every custom field for that category, free-text notes, the list of
contained nodes, and the list of highways touching it (each clickable).

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
*Törött Vasfolyam*). The same seed always yields the same atlas.

---

## Categories are expandable

Nothing about "sector" or "essence street" is hard-coded in the UI. A category
declares its own colour, glyph/line style and list of fields, and everything
else is generated from that.

**Categories…** lets you:

- add a node or link category (colour, shape or line style, size/width);
- add fields to any category — types `text`, `textarea`, `number`, `boolean`,
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
  "schemaVersion": 1,
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
        "style": "solid", "width": 3.5, "fields": [ { "key": "cost", "type": "number", "default": 1 } ] }
    ]
  },
  "nodes": [
    { "id": "n1", "name": "Ködrév", "category": "sector", "x": 0, "y": 0,
      "pinned": false, "parent": null, "data": { "essence_density": "rich" }, "notes": "" }
  ],
  "edges": [
    { "id": "e1", "from": "n1", "to": "n2", "category": "essence_street",
      "data": { "cost": 2, "travel_time": "3 watches" }, "notes": "Csendút" }
  ]
}
```

`parent` is containment (a world inside a sector), drawn as a faint tether.
`edges` are routes; their `cost` drives the Route tool's Dijkstra search, and
collapsed routes are excluded from it.

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
src/model.js           the whole data model: CRUD, validation, schema mutation, routing
src/generate.js        seeded sector-map generator
src/names.js           Hungarian-flavoured name parts
src/storage.js         atomic file persistence, name sanitising (server only)
public/index.html      app shell
public/css/style.css   styling
public/js/app.js       state, file operations, toolbar, keyboard
public/js/graph.js     SVG rendering, pan/zoom, picking, dragging, force relaxation
public/js/inspector.js schema-driven detail panel
public/js/categories.js category & field manager
public/js/api.js       fetch wrapper
test/                  node:test suites (model, generate, storage, api)
```

`src/model.js`, `src/generate.js` and `src/names.js` are imported by *both*
sides — the server mounts `src/` at `/shared/`, so the browser runs the same
validation and mutation code the API does.
