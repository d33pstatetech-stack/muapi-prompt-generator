/**
 * Real data layer for the redesigned console.
 *
 * Every function here talks to the Worker. Nothing is simulated, and there is
 * no in-memory fallback catalogue: if the Worker is unreachable the UI reports
 * the failure instead of inventing models.
 */
import { fetchModels as fetchRows, fetchModelStats, estimateCost as postEstimate, streamEnhance as postEnhance, submitGenerate, pollPrediction } from '../api';
import { applySchema, toModel, modelModality } from './models';
import type { Lora, Model, ModelSchema } from './types';

type Stats = Map<string, { runs: number; rating: number | null }>;

const errText = (v: any, fallback = ''): string => {
  if (v == null) return fallback;
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((x) => errText(x, '')).filter(Boolean).join('; ') || fallback;
  if (typeof v === 'object') return errText(v.message ?? v.error ?? v.detail ?? v.msg, fallback);
  return String(v);
};

/**
 * The real catalogue: every active model from D1, enriched with real usage
 * counts and average ratings. Stats are best-effort — if that read fails the
 * catalogue still loads, just without run counts.
 */
export async function fetchModels(): Promise<{ models: Model[]; statsFailed: boolean }> {
  const rows = await fetchRows();
  let stats: Stats | undefined;
  let statsFailed = false;
  try {
    const rows2 = await fetchModelStats({ limit: 200 });
    stats = new Map(
      rows2
        .filter((r: any) => r && r.model)
        .map((r: any) => [r.model, { runs: Number(r.runs) || 0, rating: r.avg_rating == null ? null : Number(r.avg_rating) }]),
    );
  } catch {
    statsFailed = true;
  }
  return { models: rows.map((r: any) => toModel(r, stats)), statsFailed };
}

/** Real parameter schema for one model, from D1 model_params. */
export async function fetchSchema(id: string): Promise<ModelSchema> {
  const res = await fetch(`/api/models/${encodeURIComponent(id)}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(errText(data.error || data.message, `Schema failed (${res.status})`));
  const ps = data?.paramSchema;
  return { params: ps?.params || {}, defaults: ps?.defaults || {} };
}

/** Fills the schema-derived fields (currently `loraCapable`) onto a model. */
export function withSchema(model: Model | null, schema: ModelSchema | null): Model | null {
  return model && schema ? applySchema(model, schema) : model;
}

/**
 * Real cost estimate from the Worker, which proxies MuAPI's estimate endpoint.
 * Falls back to the model's base cost so the button never shows a wrong $0.
 */
export async function estimateCost(model: Model | null, params: Record<string, unknown>): Promise<number> {
  if (!model) return 0;
  try {
    const res = await postEstimate({ modelId: model.id, params });
    const d: any = res;
    // The Worker returns { estimatedCost, currency, source }. Older/other
    // shapes have used cost/estimate; accept all rather than silently showing
    // the base price when the real number is right there.
    const v = Number(d?.estimatedCost ?? d?.cost ?? d?.estimate ?? d?.estimated_cost ?? d?.total);
    if (Number.isFinite(v) && v >= 0) return v;
  } catch {
    /* fall through to the local base cost */
  }
  return model.cost || 0;
}

/**
 * Real streaming enhancement through the Worker's SSE route, which walks the
 * configured provider chain. The selected model's own group is sent as
 * `modality` so the Worker picks the image or video template from the client's
 * reading rather than only its own derivation.
 */
export async function streamEnhance(
  rawPrompt: string,
  model: Model | null,
  onToken: (text: string) => void,
  signal?: AbortSignal,
  params: Record<string, unknown> = {},
): Promise<{ text: string; providerUsed: string; modelUsed: string; historyId: number | null }> {
  return postEnhance({ rawPrompt, modelId: model?.id || '', params, modality: modelModality(model), signal, onToken, onMeta: () => {} });
}

export interface SubmitResult {
  requestId: string;
  outputs: string[];
  cost: number;
  elapsedMs: number;
}

const POLL_MS = 2500;
const MAX_POLL_MS = 15 * 60 * 1000;

/**
 * Real generation: POST /api/generate, then poll the prediction proxy until it
 * reports a terminal state. `onProgress` carries the Worker's own status text so
 * the progress bar reflects the server, not a timer.
 */
export async function runGeneration(
  model: Model,
  params: Record<string, unknown>,
  onProgress: (p: number, phase: string) => void,
  signal: AbortSignal,
): Promise<SubmitResult> {
  const started = Date.now();
  const submitted: any = await submitGenerate({ modelId: model.id, params, enhancementId: null });
  const requestId = submitted.requestId;

  for (;;) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (Date.now() - started > MAX_POLL_MS) {
      throw new Error(`No result after 15m. The job may still be queued server-side. ID: ${requestId}`);
    }
    const d: any = await (pollPrediction as any)(requestId);
    const st = d?.status || d?.detail?.status;
    const elapsed = (Date.now() - started) / 1000;

    if (st === 'completed') {
      onProgress(1, 'Complete');
      return {
        requestId,
        outputs: d.outputs || d.output_urls || [],
        cost: Number(submitted.cost) || 0,
        elapsedMs: Date.now() - started,
      };
    }
    if (st === 'failed' || st === 'error' || st === 'canceled') {
      const msg = d?.error || d?.detail?.error || d?.message || d?.detail?.message || 'Generation failed';
      throw new Error(`${errText(msg, 'Generation failed')} [id: ${requestId}]`);
    }
    // Real states, mapped to a coarse bar. MuAPI reports processing/queued.
    onProgress(st === 'processing' ? 0.6 : st === 'queued' ? 0.2 : 0.4, `${st || 'working'} · ${elapsed.toFixed(0)}s`);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

/* ---------------- LoRAs: real library, real persistence ---------------- */

const api = {
  resolve: async (url: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<any> => {
    // 60s client timeout so a dead CDN host fails visibly instead of hanging
    // the button. Mirrors client/src/api.js resolveLoraUrl.
    const timeoutMs = opts.timeoutMs ?? 60000;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const onAbort = () => ctrl.abort();
    opts.signal && opts.signal.addEventListener('abort', onAbort);
    try {
      const res = await fetch('/api/lora/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
        signal: ctrl.signal,
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(errText(d.error || d.message, `Resolve failed (${res.status})`));
      return d;
    } catch (e: any) {
      if (e?.name === 'AbortError') throw new Error('Resolve timed out after 60s — the host may be unreachable or the CDN link expired');
      throw e;
    } finally {
      clearTimeout(timer);
      opts.signal && opts.signal.removeEventListener('abort', onAbort);
    }
  },
  customList: async (): Promise<any[]> => {
    const res = await fetch('/api/loras/custom');
    const d = await res.json().catch(() => ({}));
    if (!res.ok) return [];
    return Array.isArray(d.loras) ? d.loras : [];
  },
  customSave: async (entry: any): Promise<any> => {
    const res = await fetch('/api/loras/custom', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(errText(d.error || d.message, `Save failed (${res.status})`));
    return d;
  },
  customDelete: async (id: number | string): Promise<void> => {
    await fetch(`/api/loras/custom/${encodeURIComponent(String(id))}`, { method: 'DELETE' });
  },
  libraryList: async (): Promise<any[]> => {
    const res = await fetch('/api/loras/library');
    const d = await res.json().catch(() => ({}));
    if (!res.ok) return [];
    return Array.isArray(d.loras) ? d.loras : [];
  },
  verificationsList: async (): Promise<any[]> => {
    const res = await fetch('/api/loras/verifications');
    const d = await res.json().catch(() => ({}));
    if (!res.ok) return [];
    return Array.isArray(d.verifications) ? d.verifications : [];
  },
  evidenceList: async (): Promise<any | null> => {
    const res = await fetch('/api/loras/evidence');
    const d = await res.json().catch(() => ({}));
    if (!res.ok) return null;
    if (!d || typeof d !== 'object' || (!Array.isArray(d.pairs) && !Array.isArray(d.norm))) return null;
    return d;
  },
};

/** Custom LoRAs stored server-side in D1 (shared across devices). */
export async function fetchCustomLoras(): Promise<any[]> {
  try {
    return await api.customList();
  } catch {
    return [];
  }
}

/* Central LoRA repository (Phase A read-only). Fail-soft → null so callers
   can distinguish "unreachable/old-DB" (null, keep baked seed) from
   "reachable but empty" ([], also keep baked seed). Non-empty arrays replace
   the baked seed. */
export async function fetchLibrary(): Promise<any[] | null> {
  try {
    return await api.libraryList();
  } catch {
    return null;
  }
}

/* Run-confirmed LoRA ↔ model pairs. Fail-soft → null; callers fall back to
   baked CONFIRMED/VERIFIED lists when central is null or empty. */
export async function fetchVerifications(): Promise<any[] | null> {
  try {
    return await api.verificationsList();
  } catch {
    return null;
  }
}

/* K5 — LoRA↔model pairs proven by 4-5★ rated runs. Returns the whole payload
   ({min_runs, min_solo, pairs, norm, scanned}); setRunEvidence installs only the
   rows the Worker already flagged green. Fail-soft → null, which leaves every
   compatibility verdict exactly as it was before the endpoint existed. */
export async function fetchLoraEvidence(): Promise<any | null> {
  try {
    return await api.evidenceList();
  } catch {
    return null;
  }
}

export const resolveLoraUrl = api.resolve;
export const saveCustomLora = api.customSave;
export const deleteCustomLora = api.customDelete;

/** Maps a real loras-data.js entry onto the UI's Lora shape. */
export function toLora(entry: any, custom = false): Lora {
  const id = String(entry?.id || entry?.repo || '');
  return {
    id,
    name: entry?.name || id,
    source: custom ? 'custom' : /civitai/i.test(String(entry?.repo_url || entry?.id || '')) ? 'civitai' : 'huggingface',
    repo: repoOf(entry),
    baseFamily: entry?.baseFamily || '',
    triggers: Array.isArray(entry?.triggers) ? entry.triggers : [],
    custom,
    entry,
  };
}

export function repoOf(entry: any): string {
  const u = String(entry?.repo_url || '');
  if (u) return u.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return String(entry?.id || '');
}