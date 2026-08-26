/**
 * MuAPI Prompt Generator - Cloudflare Worker
 * 
 * Routes:
 *   GET  /api/models           → list models from D1 (with optional ?category=&family=&group_of=)
 *   GET  /api/models/:id       → single model + param schema
 *   POST /api/generate         → proxy to MuAPI (requires MUAPI_API_KEY secret)
 *   GET  /api/predictions/:id  → poll job status
 *   POST /api/estimate         → estimate cost without generating
 *   GET  /api/categories       → list distinct categories
 *   GET  /api/families         → list distinct families
 *   GET  /api/sync             → re-fetch catalog from MuAPI and update D1 (admin)
 *   *                          → static assets (public/)
 */

const MUAPI_BASE = 'https://api.muapi.ai/api/v1';
const OPENAPI_URL = 'https://api.muapi.ai/openapi.json';

const PROTECTED_API_PREFIXES = ['/api/generate', '/api/upload', '/api/predictions', '/api/estimate', '/api/sync'];

// Keep in sync with public/app grouping + scripts/parse-openapi-seed.js
const TAG_TO_CATEGORY = {
  'Image: Text-to-Image': 'Text to Image',
  'Image: Edit & Reference': 'Image to Image',
  'Image: Enhance': 'Image to Image',
  'Video: Text-to-Video': 'Text to Video',
  'Video: Image-to-Video': 'Image to Video',
  'Video: Edit & Effects': 'Video to Video',
  'Video: Lipsync': 'Audio to Video',
  'Video: Avatars': 'Audio to Video',
  'Video: Storyboard': 'Text to Video',
  Audio: 'Text to Audio',
  '3D Generation': 'Text to 3D',
  'LLM / Multimodal': 'Text to Text',
  API: 'Other',
  Utilities: 'Other',
  'Creative Agent': 'Other',
  Account: 'Other',
  Other: 'Other',
};
const STRIP_SUFFIXES = [
  '-text-to-image', '-text-to-video', '-image-to-video', '-image-to-image',
  '-text-to-3d', '-text-to-audio', '-reference-to-video', '-reference-to-image',
  '-t2i', '-t2v', '-i2v', '-i2i', '-t2a',
  '-image', '-video', '-audio',
];
function inferGroupOf(category) {
  if (!category) return null;
  const c = category.toLowerCase();
  if (c.includes('image') && !c.includes('video')) return 'image';
  if (c.includes('video')) return 'video';
  if (c.includes('audio') || c.includes('music') || c.includes('speech')) return 'audio';
  if (c.includes('3d')) return '3d';
  if (c.includes('text') && !c.includes('image') && !c.includes('video')) return 'text';
  return 'other';
}

function isAccessAuthenticated(request) {
  // Allow wrangler dev / localhost without Access (for local testing)
  const url = new URL(request.url);
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return true;
  // Real Access check: Cloudflare injects these headers after verifying JWT at edge
  const jwt = request.headers.get('Cf-Access-Jwt-Assertion');
  const email = request.headers.get('Cf-Access-Authenticated-User-Email');
  // DEBUG: uncomment next line to force-block while testing deployment
  // return false;
  return !!(jwt || email);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Cf-Access-Jwt-Assertion',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // --- Cloudflare Access gate: protect billing routes ---
    // Once you enable Access in the dashboard, Cloudflare will block unauthenticated
    // browsers *before* they hit the Worker. This check is defense-in-depth and
    // also returns a clear JSON 401 for API clients / curl.
    const needsAuth = PROTECTED_API_PREFIXES.some((p) => path.startsWith(p));
    if (needsAuth && !isAccessAuthenticated(request)) {
      const res = jsonResponse(
        {
          error: 'Authentication required',
          message:
            'This deployment is protected by Cloudflare Access. Sign in via the browser, or present a valid Cf-Access-Jwt-Assertion (service token).',
        },
        401
      );
      for (const [k, v] of Object.entries(corsHeaders)) res.headers.set(k, v);
      return res;
    }

    // API routes
    if (path.startsWith('/api/')) {
      try {
        const response = await handleApiRoute(request, env, path);
        // Add CORS to API responses
        for (const [k, v] of Object.entries(corsHeaders)) {
          response.headers.set(k, v);
        }
        return response;
      } catch (err) {
        return jsonResponse({ error: err.message }, 500, corsHeaders);
      }
    }

    // Static assets are handled by Cloudflare's asset serving
    // This worker only handles /api/* routes
    return new Response('Not found', { status: 404 });
  }
};

async function handleApiRoute(request, env, path) {
  const { DB, MUAPI_API_KEY, MUAPI_BASE_URL } = env;
  const base = MUAPI_BASE_URL || MUAPI_BASE;

  // ─── GET /api/models ───
  if (path === '/api/models' && request.method === 'GET') {
    const url = new URL(request.url);
    const category = url.searchParams.get('category');
    const family = url.searchParams.get('family');
    const groupOf = url.searchParams.get('group_of');
    const search = url.searchParams.get('q');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '500'), 1000);

    let query = 'SELECT * FROM models WHERE is_active = 1';
    const params = [];

    if (category) {
      query += ' AND category = ?';
      params.push(category);
    }
    if (family) {
      query += ' AND family = ?';
      params.push(family);
    }
    if (groupOf) {
      query += ' AND group_of = ?';
      params.push(groupOf);
    }
    if (search) {
      query += ' AND (name LIKE ? OR description LIKE ? OR family LIKE ?)';
      const s = `%${search}%`;
      params.push(s, s, s);
    }

    query += ' ORDER BY category, family, name LIMIT ?';
    params.push(limit);

    const { results } = await DB.prepare(query).bind(...params).all();
    return jsonResponse({ models: results, total: results.length });
  }

  // ─── GET /api/models/:id ───
  const modelMatch = path.match(/^\/api\/models\/([^/]+)$/);
  if (modelMatch && request.method === 'GET') {
    const modelId = decodeURIComponent(modelMatch[1]);
    const model = await DB.prepare('SELECT * FROM models WHERE id = ?').bind(modelId).first();
    if (!model) {
      return jsonResponse({ error: 'Model not found' }, 404);
    }
    const params = await DB.prepare('SELECT * FROM model_params WHERE model_id = ?').bind(modelId).first();
    let paramSchema = null;
    if (params) {
      paramSchema = {
        params: JSON.parse(params.schema_json),
        defaults: params.defaults_json ? JSON.parse(params.defaults_json) : {},
      };
    }
    return jsonResponse({ model, paramSchema });
  }

  // ─── GET /api/categories ───
  if (path === '/api/categories' && request.method === 'GET') {
    const { results } = await DB.prepare(
      'SELECT DISTINCT category, COUNT(*) as count FROM models WHERE is_active = 1 GROUP BY category ORDER BY count DESC'
    ).all();
    return jsonResponse({ categories: results });
  }

  // ─── GET /api/families ───
  if (path === '/api/families' && request.method === 'GET') {
    const url = new URL(request.url);
    const groupOf = url.searchParams.get('group_of');
    let query = 'SELECT DISTINCT family, COUNT(*) as count FROM models WHERE is_active = 1 AND family IS NOT NULL';
    const params = [];
    if (groupOf) {
      query += ' AND group_of = ?';
      params.push(groupOf);
    }
    query += ' GROUP BY family ORDER BY count DESC';
    const { results } = await DB.prepare(query).bind(...params).all();
    return jsonResponse({ families: results });
  }

  // ─── POST /api/generate ───
  if (path === '/api/generate' && request.method === 'POST') {
    if (!MUAPI_API_KEY) {
      return jsonResponse({ error: 'MUAPI_API_KEY not configured' }, 500);
    }

    const body = await request.json();
    const { modelId, params: userParams } = body;

    if (!modelId) {
      return jsonResponse({ error: 'modelId is required' }, 400);
    }

    // Look up model in D1
    const model = await DB.prepare('SELECT * FROM models WHERE id = ?').bind(modelId).first();
    if (!model) {
      return jsonResponse({ error: 'Model not found in catalog' }, 404);
    }

    // Build request body from user params — per-model typed coercion
    const apiBody = await buildApiBody(modelId, userParams || {}, env);

    // Proxy to MuAPI - endpoint in D1 already includes /api/v1/
    const apiUrl = model.endpoint.startsWith('http') ? model.endpoint : `https://api.muapi.ai${model.endpoint}`;

    let apiRes;
    try {
      apiRes = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'x-api-key': MUAPI_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(apiBody),
      });
    } catch (fetchErr) {
      return jsonResponse({ error: 'Network error', message: fetchErr.message }, 502);
    }

    // Read response body as text first
    let responseText = '';
    try {
      responseText = await apiRes.text();
    } catch {
      responseText = '';
    }

    // Try parsing as JSON
    let data = null;
    try {
      data = JSON.parse(responseText);
    } catch {
      data = null;
    }

    if (!apiRes.ok) {
      const msg = (data && (data.detail || data.error || data.message))
        || responseText
        || `HTTP ${apiRes.status}`;
      return jsonResponse({
        error: `MuAPI error (${apiRes.status})`,
        message: String(msg),
        status: apiRes.status,
      }, apiRes.status);
    }

    return jsonResponse({
      requestId: data.request_id,
      status: data.status || 'processing',
      cost: data.cost,
      model: model.name,
      endpoint: model.endpoint,
    });
  }

  // ─── GET /api/predictions/:id ───
  const predMatch = path.match(/^\/api\/predictions\/([^/]+)$/);
  if (predMatch && request.method === 'GET') {
    if (!MUAPI_API_KEY) {
      return jsonResponse({ error: 'MUAPI_API_KEY not configured' }, 500);
    }
    const requestId = decodeURIComponent(predMatch[1]);
    const apiUrl = `${base}/predictions/${requestId}/result`;
    const apiRes = await fetch(apiUrl, {
      headers: { 'x-api-key': MUAPI_API_KEY },
    });
    const data = await apiRes.json();
    return jsonResponse(data, apiRes.status);
  }

  // ─── POST /api/estimate ───
  if (path === '/api/estimate' && request.method === 'POST') {
    const body = await request.json();
    const { modelId, params: userParams } = body;

    const model = await DB.prepare('SELECT * FROM models WHERE id = ?').bind(modelId).first();
    if (!model) {
      return jsonResponse({ error: 'Model not found' }, 404);
    }

    // If model has fixed cost and no dynamic pricing, return that
    if (!model.dynamic_pricing && model.cost) {
      return jsonResponse({ estimatedCost: model.cost, currency: model.cost_currency, source: 'catalog' });
    }

    // Try estimate endpoint
    if (model.estimate_endpoint) {
      const apiBody = await buildApiBody(modelId, userParams || {}, env);
      const apiRes = await fetch(`${base.replace('/api/v1', '')}${model.estimate_endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(MUAPI_API_KEY ? { 'x-api-key': MUAPI_API_KEY } : {}),
        },
        body: JSON.stringify(apiBody),
      });
      if (apiRes.ok) {
        const data = await apiRes.json();
        return jsonResponse({ ...data, source: 'api' });
      }
    }

    return jsonResponse({ estimatedCost: model.cost, currency: model.cost_currency, source: 'catalog_fallback' });
  }

  // ─── POST /api/upload ───
  if (path === '/api/upload' && request.method === 'POST') {
    if (!MUAPI_API_KEY) {
      return jsonResponse({ error: 'MUAPI_API_KEY not configured' }, 500);
    }
    try {
      const formData = await request.formData();
      const file = formData.get('file');
      if (!file) {
        return jsonResponse({ error: 'No file provided' }, 400);
      }
      // Forward to MuAPI upload endpoint
      const uploadFormData = new FormData();
      uploadFormData.append('file', file);
      const uploadRes = await fetch(`${base}/upload_file`, {
        method: 'POST',
        headers: { 'x-api-key': MUAPI_API_KEY },
        body: uploadFormData,
      });
      const uploadData = await uploadRes.json();
      if (!uploadRes.ok) {
        return jsonResponse({ error: 'Upload failed', details: uploadData }, uploadRes.status);
      }
      return jsonResponse({ url: uploadData.url || uploadData.output_url || uploadData });
    } catch (e) {
      return jsonResponse({ error: 'Upload error: ' + e.message }, 500);
    }
  }

  // ─── POST /api/sync ───
  if (path === '/api/sync' && request.method === 'POST') {
    return await syncCatalog(env);
  }

  // ─── GET /api/health ───
  if (path === '/api/health') {
    const modelCount = await DB.prepare('SELECT COUNT(*) as count FROM models').first();
    let syncedAt = null;
    try {
      const row = await DB.prepare("SELECT value FROM catalog_meta WHERE key='last_sync'").first();
      syncedAt = row ? row.value : null;
    } catch { /* ignore */ }
    return jsonResponse({
      status: 'ok',
      models: modelCount?.count || 0,
      hasApiKey: !!MUAPI_API_KEY,
      timestamp: new Date().toISOString(),
      synced_at: syncedAt,
    });
  }

  return jsonResponse({ error: 'Not found' }, 404);
}

/**
 * Build the API request body — generic, capability-aware.
 * Looks up the stored param schema for the model so each model only
 * receives params it actually supports, with correct types (int/float/bool/array).
 * Falls back to allowlisting unknown keys as-is (forward-compatible for new models like Wan 3.0).
 */
async function buildApiBody(modelId, params, env) {
  let schemaParams = null;
  try {
    const row = await env.DB.prepare('SELECT schema_json FROM model_params WHERE model_id = ?').bind(modelId).first();
    if (row && row.schema_json) schemaParams = JSON.parse(row.schema_json);
  } catch { /* no schema — generic passthrough */ }

  const body = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) continue;
    const spec = schemaParams ? schemaParams[k] : null;
    if (spec) {
      if (spec.type === 'number') {
        const n = typeof v === 'string' ? Number(v) : v;
        if (!Number.isNaN(n)) body[k] = n;
        continue;
      }
      if (spec.type === 'boolean') {
        body[k] = v === true || v === 'true' || v === 1 || v === '1';
        continue;
      }
      if (spec.type === 'array' && !Array.isArray(v)) {
        body[k] = [v];
        continue;
      }
    } else {
      if (['width', 'height', 'num_images', 'stylize', 'chaos', 'weird', 'seed'].includes(k)) {
        const n = parseInt(v, 10);
        if (!Number.isNaN(n)) { body[k] = n; continue; }
      }
      if (k === 'duration' && typeof v === 'string') {
        const n = parseInt(v, 10);
        if (!Number.isNaN(n)) { body[k] = n; continue; }
      }
      if (k === 'images_list' && !Array.isArray(v)) { body[k] = [v]; continue; }
    }
    body[k] = v;
  }
  body.webhook_url = null;
  return body;
}

// ── OpenAPI helpers for /api/sync (same logic as scripts/build-catalog.js) ──
function mapType(t) {
  const m = { string: 'string', integer: 'number', number: 'number', boolean: 'boolean', array: 'array', object: 'object' };
  return m[t] || t || 'string';
}
function resolveRef(ref, schemas) {
  if (!ref || !ref.startsWith('#/components/schemas/')) return null;
  return schemas[ref.replace('#/components/schemas/', '')] || null;
}
function extractProperty(name, prop, schemas, requiredFields) {
  const r = { type: 'string' };
  if (prop.$ref) {
    const resolved = resolveRef(prop.$ref, schemas);
    r.type = 'object'; r.$ref = prop.$ref.replace('#/components/schemas/', '');
    if (resolved && resolved.title) r.title = resolved.title;
  } else if (prop.anyOf) {
    const nonNull = prop.anyOf.find((p) => p.type !== 'null');
    if (nonNull) {
      if (nonNull.$ref) { r.type = 'object'; r.$ref = nonNull.$ref.replace('#/components/schemas/', ''); }
      else {
        r.type = mapType(nonNull.type);
        if (nonNull.format) r.format = nonNull.format;
        if (nonNull.enum) r.options = nonNull.enum;
        if (nonNull.minimum !== undefined) r.min = nonNull.minimum;
        if (nonNull.maximum !== undefined) r.max = nonNull.maximum;
        if (nonNull.minLength !== undefined) r.minLength = nonNull.minLength;
        if (nonNull.maxLength !== undefined) r.maxLength = nonNull.maxLength;
      }
    }
    r.nullable = true;
  } else if (prop.allOf) {
    const merged = prop.allOf.find((p) => p.$ref || p.type);
    if (merged) return extractProperty(name, merged, schemas, requiredFields);
  } else {
    r.type = mapType(prop.type);
    if (prop.format) r.format = prop.format;
    if (prop.enum) r.options = prop.enum;
    if (prop.minimum !== undefined) r.min = prop.minimum;
    if (prop.maximum !== undefined) r.max = prop.maximum;
    if (prop.minLength !== undefined) r.minLength = prop.minLength;
    if (prop.maxLength !== undefined) r.maxLength = prop.maxLength;
    if (prop.items) {
      r.items = {};
      if (prop.items.$ref) r.items.$ref = prop.items.$ref.replace('#/components/schemas/', '');
      else if (prop.items.type) r.items.type = mapType(prop.items.type);
    }
  }
  if (requiredFields.includes(name)) r.required = true;
  if (prop.default !== undefined) r.default = prop.default;
  if (prop.title) r.title = prop.title;
  if (prop.description) r.description = prop.description;
  return r;
}
function extractSchema(pathItem, schemas) {
  const post = pathItem && pathItem.post;
  if (!post || !post.requestBody) return null;
  const c = post.requestBody.content;
  if (!c || !c['application/json']) return null;
  let s = c['application/json'].schema;
  if (!s) return null;
  if (s.$ref) { const r = resolveRef(s.$ref, schemas); if (!r) return null; s = r; }
  const requiredFields = s.required || [];
  const params = {}; const defaults = {};
  for (const [n, p] of Object.entries(s.properties || {})) {
    if (n === 'webhook_url') continue;
    const spec = extractProperty(n, p, schemas, requiredFields);
    params[n] = spec; if (spec.default !== undefined) defaults[n] = spec.default;
  }
  return { params, defaults };
}
function buildOpenAPILookup(paths) {
  const lookup = {};
  for (const key of Object.keys(paths)) {
    if (!key.startsWith('/api/v1/') || !paths[key].post) continue;
    const slug = key.replace('/api/v1/', '');
    lookup[slug] = key;
    for (const sfx of STRIP_SUFFIXES) {
      if (slug.endsWith(sfx)) {
        const stripped = slug.slice(0, -sfx.length);
        if (!lookup[stripped]) lookup[stripped] = key;
      }
    }
  }
  return lookup;
}

/**
 * Sync catalog from MuAPI live API + OpenAPI into D1 (models + model_params).
 * Powers the "Update" button — pulls new models like Wan 3.0 and their per-model param schemas.
 */
async function syncCatalog(env) {
  const { DB } = env;
  const started = Date.now();

  // 1. Fetch live catalog + OpenAPI in parallel
  const [catRes, specRes] = await Promise.all([fetch(MUAPI_BASE + '/models'), fetch(OPENAPI_URL)]);
  if (!catRes.ok) return jsonResponse({ error: 'Failed to fetch catalog', status: catRes.status }, 502);
  if (!specRes.ok) return jsonResponse({ error: 'Failed to fetch OpenAPI spec', status: specRes.status }, 502);

  const catalog = await catRes.json();
  const spec = await specRes.json();
  const schemas = (spec.components && spec.components.schemas) || {};
  const paths = spec.paths || {};
  const lookup = buildOpenAPILookup(paths);

  // 2. Rebuild models + model_params atomically
  const prevRow = await DB.prepare('SELECT COUNT(*) as c FROM models').first();
  const previous = prevRow ? prevRow.c : 0;

  await DB.prepare('DELETE FROM model_params').run();
  await DB.prepare('DELETE FROM models').run();

  const modelStmts = [];
  const paramStmts = [];
  let withParams = 0;

  for (const catModel of catalog.models) {
    const name = catModel.name;
    const openAPIPath = lookup[name] || null;
    const pathItem = openAPIPath ? paths[openAPIPath] : null;
    const oapiTag = pathItem && pathItem.post && pathItem.post.tags && pathItem.post.tags[0] || '';
    const category = TAG_TO_CATEGORY[oapiTag] || inferGroupOf(catModel.group_of) || 'Other';
    const groupOf = catModel.group_of || inferGroupOf(category);
    const endpoint = openAPIPath || catModel.endpoint;

    modelStmts.push(
      DB.prepare(
        'INSERT INTO models (id, name, description, category, family, group_of, cost, cost_currency, dynamic_pricing, endpoint, estimate_endpoint, playground_url, llms_txt_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(
        name, name,
        ((pathItem && pathItem.post && pathItem.post.description) || catModel.description || '').substring(0, 500),
        category, catModel.family || null, groupOf, catModel.cost || 0, catModel.cost_currency || 'USD',
        catModel.dynamic_pricing ? 1 : 0, endpoint, catModel.estimate_endpoint || null,
        `https://muapi.ai/playground/${name}`, `https://muapi.ai/playground/${name}/llms.txt`
      )
    );

    if (pathItem) {
      const schemaResult = extractSchema(pathItem, schemas);
      if (schemaResult && Object.keys(schemaResult.params).length > 0) {
        paramStmts.push(
          DB.prepare('INSERT INTO model_params (model_id, schema_json, defaults_json) VALUES (?, ?, ?)').bind(
            name, JSON.stringify(schemaResult.params), JSON.stringify(schemaResult.defaults)
          )
        );
        withParams++;
      }
    }
  }

  for (let i = 0; i < modelStmts.length; i += 50) await DB.batch(modelStmts.slice(i, i + 50));
  for (let i = 0; i < paramStmts.length; i += 50) await DB.batch(paramStmts.slice(i, i + 50));

  await DB.prepare("INSERT OR REPLACE INTO catalog_meta (key, value, updated_at) VALUES ('last_sync', datetime('now'), datetime('now'))").run();
  await DB.prepare(`INSERT OR REPLACE INTO catalog_meta (key, value, updated_at) VALUES ('total_models', '${catalog.total}', datetime('now'))`).run();

  return jsonResponse({
    ok: true,
    total: catalog.total,
    with_params: withParams,
    added: catalog.total - previous,
    previous,
    synced_at: new Date().toISOString(),
    took_ms: Date.now() - started,
  });
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
  });
}
