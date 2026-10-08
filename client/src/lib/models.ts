/**
 * Real catalogue mapper.
 *
 * Turns the D1 `models` rows served by the Worker into the shape the UI wants.
 * Every field here has a real source. Fields that the mockup invented and that
 * the backend cannot honestly supply are simply absent — see NOTES at the bottom.
 */
import { modelFamily, modelIsVideo } from '../lora-compat';
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
 * `durationHint` — omitted entirely: no model in the catalogue declares a
 *                  `duration` parameter (verified against all 724 schemas),
 *                  so there is nothing real to show. The mockup's "~5s" text
 *                  was invented and has been dropped rather than faked.
 */
export function applySchema(model: Model, schema: ModelSchema | null): Model {
  if (!schema) return model;
  const hasLora = Object.entries(schema.params).some(([name, spec]) => isLoraParam(name, spec));
  return { ...model, loraCapable: hasLora };
}

/* Mirrors params.js isLoraParam so the two stay in step; params.js is the
   authority on what gets treated as an adapter at submit time. */
function isLoraParam(name: string, spec: ParamSpec = {} as ParamSpec): boolean {
  const n = String(name || '').toLowerCase();
  if (n === 'extra_lora' || n === 'extra_lora_weights' || /(^|_)replicate_weights$/.test(n)) return true;
  if (/scale|strength|weight|multiplier/.test(n)) return false;
  if (/lora|loras|adapter/.test(n)) return true;
  // `lora_list` is an array of adapter objects; its items carry a $ref.
  if (spec.type === 'array' && /\$ref/i.test(JSON.stringify(spec.items ?? {}))) return true;
  return false;
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
   loraCapable-> REAL. Whether the model's own schema declares an adapter param
                 (25 of 765 models do).
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