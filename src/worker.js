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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
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

    // Build request body from user params
    const apiBody = buildApiBody(modelId, userParams || {});

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
      const apiBody = buildApiBody(modelId, userParams || {});
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
    return jsonResponse({
      status: 'ok',
      models: modelCount?.count || 0,
      hasApiKey: !!MUAPI_API_KEY,
      timestamp: new Date().toISOString(),
    });
  }

  return jsonResponse({ error: 'Not found' }, 404);
}

/**
 * Build the API request body for a given model from user params.
 * Handles model-specific param mapping.
 */
function buildApiBody(modelId, params) {
  const body = {};

  // Prompt is always present
  if (params.prompt) body.prompt = params.prompt;

  // Aspect ratio (most video/image models)
  if (params.aspect_ratio) body.aspect_ratio = params.aspect_ratio;

  // Dimensions (Flux, GPT-4o, etc.)
  if (params.width) body.width = parseInt(params.width);
  if (params.height) body.height = parseInt(params.height);
  if (params.num_images) body.num_images = parseInt(params.num_images);

  // Midjourney-specific
  if (params.stylize !== undefined) body.stylize = parseInt(params.stylize);
  if (params.chaos !== undefined) body.chaos = parseInt(params.chaos);
  if (params.weird !== undefined) body.weird = parseInt(params.weird);
  if (params.negative_prompt) body.negative_prompt = params.negative_prompt;
  if (params.seed !== undefined) body.seed = parseInt(params.seed);

  // Image reference (I2V, edit models, Midjourney)
  if (params.image_url) body.image_url = params.image_url;
  if (params.last_image) body.last_image = params.last_image;

  // Multi-image (Veo I2V, Seedance omni)
  if (params.images_list) {
    body.images_list = Array.isArray(params.images_list)
      ? params.images_list
      : [params.images_list];
  }

  // Video-specific
  if (params.duration) {
    body.duration = typeof params.duration === 'string' ? parseInt(params.duration) : params.duration;
  }
  if (params.resolution) body.resolution = params.resolution;
  if (params.quality) body.quality = params.quality;
  if (params.style) body.style = params.style;

  // Audio-specific
  if (params.lyrics) body.lyrics = params.lyrics;

  // 3D-specific
  if (params.texture_quality) body.texture_quality = params.texture_quality;
  if (params.topology) body.topology = params.topology;

  // Webhook (always null for client-side polling)
  body.webhook_url = null;

  return body;
}

/**
 * Sync catalog from MuAPI live API into D1.
 */
async function syncCatalog(env) {
  const { DB } = env;

  const res = await fetch(MUAPI_BASE + '/models');
  if (!res.ok) {
    return jsonResponse({ error: 'Failed to fetch catalog', status: res.status }, 502);
  }
  const catalog = await res.json();

  // Clear and re-insert
  await DB.prepare('DELETE FROM models').run();

  const stmts = [];
  for (const model of catalog.models) {
    stmts.push(
      DB.prepare(
        `INSERT OR REPLACE INTO models (id, name, description, category, family, group_of, cost, cost_currency, dynamic_pricing, endpoint, estimate_endpoint, playground_url, llms_txt_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        model.name,
        model.name,
        model.description || '',
        model.category || '',
        model.family || null,
        model.group_of || null,
        model.cost || 0,
        model.cost_currency || 'USD',
        model.dynamic_pricing ? 1 : 0,
        model.endpoint || '',
        model.estimate_endpoint || null,
        `https://muapi.ai/playground/${model.name}`,
        `https://muapi.ai/playground/${model.name}/llms.txt`
      )
    );
  }

  // Batch insert (D1 supports up to 100 per batch)
  for (let i = 0; i < stmts.length; i += 50) {
    await DB.batch(stmts.slice(i, i + 50));
  }

  // Update meta
  await DB.prepare("INSERT OR REPLACE INTO catalog_meta (key, value, updated_at) VALUES ('last_sync', datetime('now'), datetime('now'))").run();
  await DB.prepare(`INSERT OR REPLACE INTO catalog_meta (key, value, updated_at) VALUES ('total_models', '${catalog.total}', datetime('now'))`).run();

  return jsonResponse({ synced: catalog.total, total: catalog.total });
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
