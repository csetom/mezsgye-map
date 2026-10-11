#!/usr/bin/env node
/**
 * Mezsgye Atlas — HTTP server.
 *
 * Zero dependencies: node:http serves the static UI from `public/`, the shared
 * model modules from `src/` under `/shared/`, and a small JSON API for the
 * stored atlas files.
 *
 * Binds to 127.0.0.1 by default. There is no authentication — see README.
 *
 * Env:
 *   PORT          default 7311
 *   HOST          default 127.0.0.1
 *   ATLAS_DATA    default ./data
 */

import http from 'node:http';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { AtlasStore, StorageError, safeName } from './src/storage.js';
import { createEmptyGraph, defaultSchema, normalizeGraph, validateGraph } from './src/model.js';
import { GENERATOR_DEFAULTS, generateAtlas } from './src/generate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, 'public');
const SHARED_DIR = path.join(HERE, 'src');

const PORT = Number(process.env.PORT ?? 7311);
const HOST = process.env.HOST ?? '127.0.0.1';
const DATA_DIR = process.env.ATLAS_DATA ?? path.join(HERE, 'data');
const MAX_BODY = 8 * 1024 * 1024; // 8 MB — a very large atlas is still far smaller

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

const store = new AtlasStore(DATA_DIR);

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendError(res, status, message, extra = {}) {
  sendJson(res, status, { error: message, ...extra });
}

/**
 * Read a JSON request body with a hard size cap.
 *
 * @param {http.IncomingMessage} req
 * @returns {Promise<any>}
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new StorageError('Request body too large.', 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(new StorageError(`Body is not valid JSON: ${err.message}`, 400));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Serve a static file from one of the allowed roots.
 *
 * @param {http.ServerResponse} res
 * @param {string} root absolute directory the file must live in
 * @param {string} relative url path, already decoded
 */
async function serveStatic(res, root, relative) {
  const target = path.join(root, relative);
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    sendError(res, 403, 'Forbidden path.');
    return;
  }
  let info;
  try {
    info = await stat(target);
  } catch {
    sendError(res, 404, 'Not found.');
    return;
  }
  if (info.isDirectory()) {
    await serveStatic(res, root, path.join(relative, 'index.html'));
    return;
  }
  const type = MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, {
    'content-type': type,
    'content-length': info.size,
    'cache-control': 'no-cache',
  });
  createReadStream(target).pipe(res);
}

/* ------------------------------------------------------------------ *
 * API
 * ------------------------------------------------------------------ */

/**
 * Route /api/* requests.
 *
 * GET    /api/health                 → liveness + data dir
 * GET    /api/schema                 → the default schema and generator defaults
 * GET    /api/graphs                 → list stored atlases
 * POST   /api/graphs                 → { name, graph? } create (409 if exists)
 * GET    /api/graphs/:name           → load one
 * PUT    /api/graphs/:name           → { graph } save (creates or overwrites)
 * DELETE /api/graphs/:name           → delete one
 * POST   /api/validate               → { graph } → validation report
 * POST   /api/generate               → generator options → a new graph (not saved)
 */
async function handleApi(req, res, url) {
  const segments = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const [, resource, ...rest] = segments;

  if (resource === 'health' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, dataDir: store.dir, pid: process.pid });
    return;
  }

  if (resource === 'schema' && req.method === 'GET') {
    sendJson(res, 200, { schema: defaultSchema(), generatorDefaults: GENERATOR_DEFAULTS });
    return;
  }

  if (resource === 'validate' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const validation = validateGraph(body?.graph ?? body);
    sendJson(res, 200, validation);
    return;
  }

  if (resource === 'generate' && req.method === 'POST') {
    const body = (await readJsonBody(req)) ?? {};
    const graph = generateAtlas(body);
    sendJson(res, 200, { graph });
    return;
  }

  if (resource === 'graphs') {
    const name = rest.length ? decodeURIComponent(rest[0]) : null;

    if (!name) {
      if (req.method === 'GET') {
        sendJson(res, 200, { graphs: await store.list() });
        return;
      }
      if (req.method === 'POST') {
        const body = (await readJsonBody(req)) ?? {};
        if (!body.name) throw new StorageError('A `name` is required.');
        const slug = safeName(body.name);
        if (await store.exists(slug)) {
          throw new StorageError(`An atlas named "${slug}" already exists.`, 409);
        }
        const graph = body.graph
          ? normalizeGraph(body.graph)
          : createEmptyGraph({ title: body.title ?? body.name });
        const saved = await store.save(slug, graph);
        sendJson(res, 201, saved);
        return;
      }
      sendError(res, 405, 'Method not allowed.');
      return;
    }

    if (req.method === 'GET') {
      sendJson(res, 200, await store.load(name));
      return;
    }
    if (req.method === 'PUT') {
      const body = await readJsonBody(req);
      const incoming = body?.graph ?? body;
      if (!incoming) throw new StorageError('A `graph` is required.');
      const validation = validateGraph(incoming);
      if (!validation.ok) {
        sendError(res, 422, 'Atlas is invalid.', validation);
        return;
      }
      sendJson(res, 200, await store.save(name, incoming));
      return;
    }
    if (req.method === 'DELETE') {
      await store.remove(name);
      sendJson(res, 200, { ok: true, name: safeName(name) });
      return;
    }
    sendError(res, 405, 'Method not allowed.');
    return;
  }

  sendError(res, 404, 'Unknown endpoint.');
}

/* ------------------------------------------------------------------ *
 * Server
 * ------------------------------------------------------------------ */

/**
 * Build the HTTP server (exported so tests can start it on an ephemeral port).
 *
 * @returns {http.Server}
 */
export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    try {
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url);
        return;
      }
      if (url.pathname.startsWith('/shared/')) {
        await serveStatic(res, SHARED_DIR, decodeURIComponent(url.pathname.slice('/shared/'.length)));
        return;
      }
      const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
      await serveStatic(res, PUBLIC_DIR, rel.replace(/^\/+/, ''));
    } catch (err) {
      if (err instanceof StorageError) {
        sendError(res, err.status, err.message);
        return;
      }
      process.stderr.write(`[atlas] unhandled: ${err?.stack ?? err}\n`);
      if (!res.headersSent) sendError(res, 500, 'Internal error.');
      else res.end();
    }
  });
}

/** Start listening. Exported for tests. */
export async function start({ port = PORT, host = HOST } = {}) {
  await store.init();
  const server = createServer();
  await new Promise((resolve) => server.listen(port, host, resolve));
  return server;
}

export { store };

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const server = await start();
  const addr = server.address();
  const localOnly = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';
  process.stdout.write(
    `\n  Mezsgye Atlas running at http://${HOST}:${addr.port}\n`
    + `  data directory: ${store.dir}\n`
    + (localOnly
      ? '  no authentication — bound to localhost only\n\n'
      : `  WARNING: no authentication, and bound to ${HOST}. Anyone who can reach\n`
        + '           this port can read, edit and delete every stored atlas.\n\n'),
  );
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
    });
  }
}
