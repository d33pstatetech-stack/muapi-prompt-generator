/**
 * Real catalogue mapper.
 *
 * Turns the D1 `models` rows served by the Worker into the shape the UI wants.
 * Every field here has a real source. Fields that the mockup invented and that
 * the backend cannot honestly supply are simply absent — see NOTES at the bottom.
 */
import { modelFamily, modelIsVideo } from '../lora-compat';
import { isLoraParam } from '../params';
import type { Model, ModelSchema, ParamSpec } from './types';

/* The Worker stores `group_of` with MuAPI's own vocabulary, which is far finer
   than the five media types the catalogue filter offers ("video-edit",
   "image-tools", "seo", "music", "avatar", …). Collapse it honestly: a keyword
   match beats dropping a model into "other", because every one of these really
   is that kind of media. */
const GROUP_RULES: [RegExp, Model['group']][] = [
  [/3d|three[-_ ]?d|mesh|voxel/i, '3d'],
  [/video|animate|motion|t2v|i2v|v2v|avatar|lip[-_ ]?sync|talking|face[-_ ]?dance/i, 'video'],
  [/audio|speech|voice|sound|music|song|tts|stt|sing|sfx|transcri/i, 'audio'],
  [/image|picture|photo|draw|paint|illustrat|upscal|restor|enhanc|background|remove|edit|face|inpaint|logo|icon|render|thumbnail|text[-_ ]?to[-_ ]?image/i, 'image'],
  [/text|llm|chat|prompt|seo|translat|summar|classif|extract|ocr|spell|grammar|rewrit/i, 'text'],
  // Social publishing utilities take copy and post it; they are text tools
  // that happen to live under group_of "utility".
  [/publish|instagram|tiktok|pinterest|linkedin|threads|youtube|facebook|twitter|social/i, 'text'],
];

export function normalizeGroup(row: Row): Model['group'] {
  const hay = [row.group_of, row.category, row.family, row.id, row.name].filter(Boolean).join(' ');
  for (const [re, g] of GROUP_RULES) if (re.test(hay)) return g;
  // Unknown group_of: fall back on the pipeline heuristic already used by the
  // compatibility checker, then to image (the dominant category).
  return modelIsVideo(row) ? 'video' : 'image';
}

/**
 * The `body.modality` the enhance request sends, or null when this model is
 * neither image nor video (audio/3d/text — the Worker has no image/video
 * template to override, so it should derive the media type itself).
 */
export function modelModality(m: Model | null): 'image' | 'video' | null {
  if (!m) return null;
  if (m.group === 'video') return 'video';
  if (m.group === 'image') return 'image';
  return null;
}

/** Real usage counts and average ratings, keyed by model id. */
export type Stats = Map<string, { runs: number; rating: number | null }>;

/**
 * One D1 row + its optional real usage stats -> the UI's Model.
 *
 * `loraCapable` is left false here and filled in by `applySchema` once the
 * model's real parameter schema has loaded — it is derived from whether the
 * schema actually declares an adapter parameter, not guessed from the family.
 */
export function toModel(row: Row, stats?: Stats): Model {
  const s = stats?.get(row.id);
  return {
    id: row.id,
    name: row.name || row.id,
    family: row.family || '',
    category: row.category || '',
    group: normalizeGroup(row),
    cost: Number(row.cost) || 0,
    dynamicPricing: !!Number(row.dynamic_pricing),
    runs: s?.runs ?? 0,
    rating: s?.rating ?? null,
    // Real MuAPI model blurb — all 765 active rows carry a description.
    summary: row.description || '',
    loraCapable: false,
    baseFamily: modelFamily(row) || '',
    // Kept so the LoRA writers can build the submission payload.
    _row: row,
  };
}

/**
 * Fill in the two schema-derived fields once the real param schema arrives.
 *
 * `loraCapable`  — true when the schema declares a LoRA/adapter parameter.
 *                  The gate is params.js isLoraParam, imported rather than
 *                  copied: a second copy is how this drifted in the first
 *                  place. It is type-aware, so a numeric `lora_rank` on a
 *                  trainer is no longer read as an adapter slot.
 * `durationHint` — omitted entirely: no model in the catalogue declares a
 *                  `duration` parameter (verified against all 724 schemas),
 *                  so there is nothing real to show. The mockup's "~5s" text
 *                  was invented and has been dropped rather than faked.
 */
export function applySchema(model: Model, schema: ModelSchema | null): Model {
  if (!schema) return model;
  const hasLora = Object.entries(schema.params).some(([name, spec]) => isLoraParam(name, spec as any));
  return { ...model, loraCapable: hasLora };
}

/* ------------------------------------------------------------------
   Tier A / Tier B — how much LoRA support a model actually has.

   Tier A  the provider's own schema declares an adapter param. Verified.
   Tier B  no adapter param in the schema, but the architecture is one this
           catalogue is known to serve adapters for. UNVERIFIED, opt-in only.
   none   no evidence at all. No LoRA UI.

   TIER_B_FAMILIES is EMPTY for MuAPI, and that is a result, not an omission.
   Queried live against the `muapi-models` D1 (765 models / 724 schemas):

     WITH props AS (SELECT p.model_id mid, lower(je.key) k,
                          lower(COALESCE(json_extract(je.value,'$.type'),'')) ty
                   FROM model_params p, json_each(p.schema_json) je) ...
     -- 20 of 724 models declare an adapter param, and EVERY ONE of their ids
     -- contains "lora": flux-2-klein-9b-text-to-image-lora, sdxl-lora,
     -- qwen-image-edit-lora, wan2.1-lora-t2v, z-image-*-lora, krea-v2-turbo-lora…

   MuAPI splits each architecture into a base endpoint and a separate `-lora`
   endpoint (flux-2-klein-9b vs flux-2-klein-9b-text-to-image-lora, sdxl-image vs
   sdxl-lora, qwen-image vs qwen-image-text-to-image-lora). That split only
   exists because the base endpoint does NOT take an adapter param — otherwise
   the `-lora` twin would be redundant. So the 37 base models in those families
   are the exact models an injected `extra_lora` would be rejected by, and they
   get no LoRA input at all.

   The families that looked plausible and were dropped for weak evidence:
   z-image (its 3 `-lora` siblings are filed under family `image-generation`,
   so `family` is not a reliable signal there), flux-3, sd-2/seedance,
   hunyuan, qwen2 — none has a single non-trainer adapter model in the
   catalogue.
   ------------------------------------------------------------------ */
const TIER_B_FAMILIES: ReadonlySet<string> = new Set<string>([]);

export type LoraTier = 'A' | 'B' | null;

/** What the UI needs to render an unverified adapter slot, or null. */
export interface TierBLora {
  /** Family key that qualified this model. */
  family: string;
  /** Why it is a candidate, in words a user can check. */
  reason: string;
}

/**
 * Tier B eligibility: a family on the allow-list, no adapter param in this
 * model's own schema, and not a trainer (a trainer takes `lora_rank`, it does
 * not load one).
 */
export function tierBLoraFor(model: Model | null, schema: ModelSchema | null): TierBLora | null {
  if (!model || !schema) return null;
  if (Object.entries(schema.params).some(([n, s]) => isLoraParam(n, s as any))) return null;
  if (model._row && isTrainingRow(model._row as Row)) return null;
  if (!TIER_B_FAMILIES.has(model.family)) return null;
  return {
    family: model.family,
    reason: `The ${model.family} family serves adapters on other models in this catalogue, but ${model.name} declares no adapter parameter of its own.`,
  };
}

function isTrainingRow(row: Row): boolean {
  return row.group_of === 'training' || /train/i.test(String(row.id || ''));
}

/**
 * Combined verdict, for the one line of copy the Composer shows.
 *
 * Derived from the schema rather than from `model.loraCapable`, so it cannot
 * disagree with `tierBLoraFor` about the same model — the two used to read
 * different sources (one the already-applied flag, one the live schema) and
 * could report "no adapters" for a model whose merged schema clearly had one.
 */
export function loraTier(model: Model | null, schema: ModelSchema | null): LoraTier {
  if (!model || !schema) return null;
  if (Object.entries(schema.params).some(([n, s]) => isLoraParam(n, s as any))) return 'A';
  return tierBLoraFor(model, schema) ? 'B' : null;
}

/** The adapter params this model's real schema declares. */
export function adapterParams(schema: ModelSchema | null): string[] {
  if (!schema) return [];
  return Object.entries(schema.params)
    .filter(([name, spec]) => isLoraParam(name, spec as any))
    .map(([name]) => name);
}

/* ------------------------------------------------------------------
   NOTES — mockup fields with no honest source, and what replaced them.

   runs       -> REAL. COUNT(*) grouped by model in the runs table, read via
                 GET /api/history/model-stats. The mockup used a PRNG.
   rating     -> REAL. AVG(rating) over the same rows. Null when unrated.
                 The mockup used a PRNG.
   cost       -> REAL. models.cost + models.dynamic_pricing.
   summary    -> REAL. models.description.
   group      -> REAL models.group_of, normalised (see GROUP_RULES).
   baseFamily -> REAL. Existing lora-compat modelFamily().
loraCapable-> REAL. Whether the model's own schema declares an adapter param.
                  Re-measured 2026-10-08 against all 724 live schemas with the
                  type-aware gate: 20 models, not the 25/32 previously claimed.
                  The old count was inflated by numeric `lora_rank` on four
                  trainer endpoints.
   durationHint-> DISCARDED. Zero models declare a `duration` parameter, so
                 there is no real value to show. Not faked, not guessed.
   familyCount-> REAL, counted from the rows actually returned.
   ------------------------------------------------------------------ */

export interface Row {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  family: string | null;
  group_of: string | null;
  cost: number | null;
  dynamic_pricing: number | null;
  endpoint: string | null;
  is_active: number | null;
}