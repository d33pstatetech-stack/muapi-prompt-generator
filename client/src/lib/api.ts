/**
 * Real data layer for the redesigned console.
 *
 * Every function here talks to the Worker. Nothing is simulated, and there is
 * no in-memory fallback catalogue: if the Worker is unreachable the UI reports
 * the failure instead of inventing models.
 */
import { fetchModels as fetchRows, fetchModelStats, estimateCost as postEstimate, streamEnhance as postEnhance, submitGenerate, pollPrediction } from '../api';
import { applySchema, toModel } from './models';
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
 * configured OpenRouter -> Venice provider chain.
 */
export async function streamEnhance(
  rawPrompt: string,
  model: Model | null,
  onToken: (text: string) => void,
  signal?: AbortSignal,
  params: Record<string, unknown> = {},
): Promise<{ text: string; providerUsed: string; modelUsed: string; historyId: number | null }> {
  return postEnhance({ rawPrompt, modelId: model?.id || '', params, signal, onToken, onMeta: () => {} });
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
  resolve: async (url: string): Promise<any> => {
    const res = await fetch('/api/lora/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(errText(d.error || d.message, `Resolve failed (${res.status})`));
    return d;
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
};

/** Custom LoRAs stored server-side in D1 (shared across devices). */
export async function fetchCustomLoras(): Promise<any[]> {
  try {
    return await api.customList();
  } catch {
    return [];
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