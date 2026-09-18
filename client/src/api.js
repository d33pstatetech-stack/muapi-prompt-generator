// Thin wrappers over the existing MuAPI worker API (unchanged backend).
const API = '';

async function json(res) {
  const t = await res.text();
  try {
    return JSON.parse(t);
  } catch {
    return { _raw: t };
  }
}

export function errText(v, fallback = '') {
  if (v == null) return fallback;
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((x) => errText(x, '')).filter(Boolean).join('; ') || fallback;
  if (typeof v === 'object') return errText(v.message ?? v.error ?? v.detail ?? v.msg, fallback);
  return String(v);
}

export async function fetchModels() {
  const res = await fetch(`${API}/api/models?limit=1000`);
  const data = await json(res);
  if (!res.ok) throw new Error(errText(data.message || data.error, `Models failed (${res.status})`));
  return Array.isArray(data) ? data : data.models || [];
}

export async function fetchHealth() {
  const res = await fetch(`${API}/api/health`);
  return json(res);
}

export async function syncCatalog() {
  const res = await fetch(`${API}/api/sync`, { method: 'POST' });
  const data = await json(res);
  if (!res.ok) throw new Error(errText(data.message || data.error, `Sync failed (${res.status})`));
  return data;
}

export async function fetchModel(id) {
  const res = await fetch(`${API}/api/models/${encodeURIComponent(id)}`);
  const data = await json(res);
  if (!res.ok) throw new Error(errText(data.message || data.error, `Model failed (${res.status})`));
  return data;
}

export async function submitGenerate({ modelId, params, enhancementId }) {
  const res = await fetch(`${API}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelId, params, enhancementId: enhancementId || null }),
  });
  const data = await json(res);
  if (!res.ok) {
    throw new Error(errText(data.message, '') || errText(data.error, '') || errText(data.details?.detail, '') || `Generation failed (${res.status})`);
  }
  return data; // { requestId, cost }
}

export async function pollPrediction(requestId) {
  const res = await fetch(`${API}/api/predictions/${requestId}`);
  const data = await json(res);
  if (!res.ok) throw new Error(errText(data.error || data.message, `Poll failed (${res.status})`));
  return data; // { status, outputs?, error? }
}

export async function estimateCost({ modelId, params }) {
  const res = await fetch(`${API}/api/estimate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelId, params }),
  });
  return json(res);
}

export async function uploadFileBlob(file) {
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch(`${API}/api/upload`, { method: 'POST', body: fd });
  const data = await json(res);
  if (!res.ok) throw new Error(errText(data.message || data.error, `Upload failed (${res.status})`));
  return data;
}

export async function saveOutputs({ model, jobId, outputs }) {
  const res = await fetch(`${API}/api/muapi/save-outputs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, jobId, outputs }),
  });
  return json(res);
}

export async function linkEnhancement({ externalJobId, enhancementId }) {
  try {
    await fetch(`${API}/api/history/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'muapi', external_job_id: externalJobId, enhancement_id: enhancementId }),
    });
  } catch {
    /* fire-and-forget */
  }
}

export async function rateJob({ externalJobId, rating }) {
  const res = await fetch(`${API}/api/history/rate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'muapi', external_job_id: externalJobId, rating }),
  });
  return json(res);
}

export async function cloudList({ prefix = '', flat = false, cursor = null } = {}) {
  const q = new URLSearchParams({ prefix, ...(flat ? { flat: '1' } : {}), ...(cursor ? { cursor } : {}) });
  const res = await fetch(`${API}/api/cloud/list?${q}`);
  const data = await json(res);
  if (!res.ok) throw new Error(errText(data.error || data.message, `R2 list failed (${res.status})`));
  return data; // { files, folders?, cursor? }
}

export function cloudFileUrl(key) {
  return `${API}/api/cloud/file?key=${encodeURIComponent(key)}`;
}

export async function cloudResolve(key) {
  const res = await fetch(`${API}/api/cloud/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  });
  const data = await json(res);
  if (!res.ok) throw new Error(errText(data.error || data.message, `Resolve failed (${res.status})`));
  return data; // { url, via }
}

export async function fetchLlmConfig(signal) {
  const res = await fetch(`${API}/api/llm-config`, { signal });
  return json(res);
}

export async function saveLlmConfig(config) {
  await fetch(`${API}/api/llm-config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config: config }),
  }).catch(() => {});
}

export async function streamEnhance({ input, model, context, signal, onToken, onMeta }) {
  const res = await fetch(`${API}/api/enhance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input, model, context }),
    signal,
  });
  if (!res.ok || !res.body) {
    const data = await json(res).catch(() => ({}));
    throw new Error(errText(data.error || data.message, `Enhance failed (${res.status})`));
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const ev = JSON.parse(payload);
        if (ev.token) {
          out += ev.token;
          onToken && onToken(out);
        } else if (ev.enhancement_id || ev.model || ev.error) {
          onMeta && onMeta(ev);
        }
      } catch {
        /* partial chunk */
      }
    }
  }
  return out;
}
