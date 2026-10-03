/**
 * Bridges the existing lora-compat.js verdicts onto the redesign's Tier type.
 *
 * lora-compat returns 'no' for incompatible; the redesign calls that
 * 'unsupported'. Everything else passes through unchanged. The logic itself is
 * NOT reimplemented here — the real tiers (verified / likely / no) already exist
 * in lora-compat.js and are driven by VERIFIED_LORA_RUNS plus the curated
 * per-provider target models.
 */
import { modelTierForLora } from '../lora-compat';
import type { Lora, Model, Tier } from './types';

const toTier = (t: string): Tier => (t === 'no' ? 'unsupported' : (t as Tier));

/** Best tier for `model` across the pinned adapters. */
export function tierFor(model: Model | null, loras: Lora[]): Tier {
  if (!model || !loras.length) return 'likely';
  let best: Tier = 'unsupported';
  for (const l of loras) {
    const t = toTier(modelTierForLora(l.entry, model._row ?? model, model.id));
    if (t === 'verified') return 'verified';
    if (t === 'likely') best = 'likely';
  }
  return best;
}

/** Tiers for every model against the pinned adapters, as a lookup map. */
export function tierMap(models: Model[], loras: Lora[]): Map<string, Tier> {
  const m = new Map<string, Tier>();
  if (!loras.length) return m;
  for (const mo of models) m.set(mo.id, tierFor(mo, loras));
  return m;
}

/** Compatible adapters first — picking an incompatible one wastes a paid run. */
export function sortForModel(list: Lora[], model: Model | null): Lora[] {
  const byName = (a: Lora, b: Lora) => a.name.localeCompare(b.name);
  if (!model?.baseFamily) return [...list].sort(byName);
  return [...list].sort((a, b) => {
    const ca = a.baseFamily === model.baseFamily ? 0 : 1;
    const cb = b.baseFamily === model.baseFamily ? 0 : 1;
    return ca - cb || byName(a, b);
  });
}