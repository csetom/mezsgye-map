/**
 * Thin wrapper around the atlas JSON API.
 * Every call rejects with an Error carrying the server's message.
 */

async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { error: text.slice(0, 300) };
    }
  }
  if (!res.ok) {
    const err = new Error(payload?.error ?? `${method} ${url} failed (${res.status})`);
    err.status = res.status;
    err.payload = payload;
    throw err;
  }
  return payload;
}

export const api = {
  /** @returns {Promise<{ok: boolean, dataDir: string}>} */
  health: () => request('GET', '/api/health'),

  /** Default schema + generator defaults. */
  schema: () => request('GET', '/api/schema'),

  /** @returns {Promise<Array>} stored atlas descriptors */
  async listGraphs() {
    const { graphs } = await request('GET', '/api/graphs');
    return graphs;
  },

  /** @param {string} name */
  loadGraph: (name) => request('GET', `/api/graphs/${encodeURIComponent(name)}`),

  /**
   * Create a new stored atlas.
   * @param {string} name
   * @param {object} [graph]
   */
  createGraph: (name, graph) => request('POST', '/api/graphs', { name, graph }),

  /**
   * Overwrite (or create) a stored atlas.
   * @param {string} name
   * @param {object} graph
   */
  saveGraph: (name, graph) => request('PUT', `/api/graphs/${encodeURIComponent(name)}`, { graph }),

  /** @param {string} name */
  deleteGraph: (name) => request('DELETE', `/api/graphs/${encodeURIComponent(name)}`),

  /** Server-side validation report. */
  validate: (graph) => request('POST', '/api/validate', { graph }),

  /**
   * Generate an atlas server-side.
   * @param {object} options generator options
   */
  async generate(options) {
    const { graph } = await request('POST', '/api/generate', options);
    return graph;
  },
};
