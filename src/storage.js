/**
 * Mezsgye Atlas — file persistence (server only).
 *
 * Atlases are stored as pretty-printed JSON files in a single data directory.
 * Every incoming name is reduced to a safe slug and re-joined to the data
 * directory, then checked to still be inside it, so a crafted name like
 * "../../etc/passwd" cannot escape.
 */

import { readdir, readFile, rename, stat, unlink, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { normalizeGraph, serialize, validateGraph } from './model.js';

const EXT = '.atlas.json';

/** Error thrown for caller mistakes (bad name, missing file, invalid document). */
export class StorageError extends Error {
  /**
   * @param {string} message
   * @param {number} status HTTP-ish status for the API layer
   */
  constructor(message, status = 400) {
    super(message);
    this.name = 'StorageError';
    this.status = status;
  }
}

/**
 * Reduce an arbitrary string to a safe file slug.
 *
 * @param {string} name
 * @returns {string} slug containing only [a-z0-9_-]
 * @throws {StorageError} if nothing usable remains
 */
export function safeName(name) {
  const base = String(name ?? '')
    .replace(new RegExp(`${EXT.replace('.', '\\.')}$`, 'i'), '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  if (!base) throw new StorageError('Atlas name must contain at least one letter or digit.');
  return base;
}

/** Storage bound to one data directory. */
export class AtlasStore {
  /** @param {string} dir directory to keep atlas files in */
  constructor(dir) {
    this.dir = path.resolve(dir);
  }

  /** Create the data directory if it does not exist. */
  async init() {
    await mkdir(this.dir, { recursive: true });
    return this;
  }

  /**
   * Resolve a name to an absolute path inside the data directory.
   *
   * @param {string} name
   * @returns {string}
   */
  pathFor(name) {
    const file = path.join(this.dir, `${safeName(name)}${EXT}`);
    const rel = path.relative(this.dir, file);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new StorageError('Refusing to touch a path outside the data directory.', 400);
    }
    return file;
  }

  /**
   * List stored atlases, newest first.
   *
   * @returns {Promise<Array<{name: string, title: string, nodes: number, edges: number,
   *                          modified: string, bytes: number}>>}
   */
  async list() {
    let entries = [];
    try {
      entries = await readdir(this.dir);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const out = [];
    for (const entry of entries) {
      if (!entry.toLowerCase().endsWith(EXT)) continue;
      const name = entry.slice(0, -EXT.length);
      const full = path.join(this.dir, entry);
      try {
        const [info, text] = await Promise.all([stat(full), readFile(full, 'utf8')]);
        let parsed = {};
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = {};
        }
        out.push({
          name,
          title: parsed?.meta?.title ?? name,
          nodes: Array.isArray(parsed?.nodes) ? parsed.nodes.length : 0,
          edges: Array.isArray(parsed?.edges) ? parsed.edges.length : 0,
          modified: info.mtime.toISOString(),
          bytes: info.size,
        });
      } catch {
        // Unreadable file: skip rather than fail the whole listing.
      }
    }
    out.sort((a, b) => b.modified.localeCompare(a.modified));
    return out;
  }

  /**
   * Load and normalise an atlas.
   *
   * @param {string} name
   * @returns {Promise<{name: string, graph: object, validation: object}>}
   */
  async load(name) {
    const file = this.pathFor(name);
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') throw new StorageError(`No atlas named "${safeName(name)}".`, 404);
      throw err;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new StorageError(`Atlas file is not valid JSON: ${err.message}`, 422);
    }
    const validation = validateGraph(parsed);
    return { name: safeName(name), graph: normalizeGraph(parsed), validation };
  }

  /**
   * Validate, normalise and write an atlas atomically (temp file + rename).
   *
   * @param {string} name
   * @param {object} graph
   * @returns {Promise<{name: string, graph: object, validation: object}>}
   */
  async save(name, graph) {
    const slug = safeName(name);
    const validation = validateGraph(graph);
    if (!validation.ok) {
      throw new StorageError(`Refusing to save an invalid atlas: ${validation.errors.join(' ')}`, 422);
    }
    const normalized = normalizeGraph(graph);
    normalized.meta.modified = new Date().toISOString();

    await mkdir(this.dir, { recursive: true });
    const file = this.pathFor(slug);
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, serialize(normalized), 'utf8');
    await rename(tmp, file);
    return { name: slug, graph: normalized, validation };
  }

  /**
   * Delete an atlas.
   *
   * @param {string} name
   * @returns {Promise<boolean>} true if a file was removed
   */
  async remove(name) {
    const file = this.pathFor(name);
    try {
      await unlink(file);
      return true;
    } catch (err) {
      if (err.code === 'ENOENT') throw new StorageError(`No atlas named "${safeName(name)}".`, 404);
      throw err;
    }
  }

  /**
   * Check existence without reading the whole file.
   *
   * @param {string} name
   */
  async exists(name) {
    try {
      await stat(this.pathFor(name));
      return true;
    } catch {
      return false;
    }
  }
}

export { EXT as ATLAS_EXTENSION };
