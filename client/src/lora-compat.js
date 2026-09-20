// LoRA ↔ model compatibility — single source of truth for intelligent filtering.
// A LoRA is compatible with the selected model when:
//   1. exact: the LoRA's curated `muapi_model` equals the selected model id, or
//   2. family: the LoRA's base-model family matches the model's family, AND
//      the pipeline matches (video LoRAs only for video models and vice versa).
// Unknown models (no family signal) show everything; the picker offers a
// "show all" escape hatch so curated exact matches are never hidden by a bad guess.

export function loraFamily(l) {
  const b = String(l?.base_model || '');
  if (/flux/i.test(b)) return 'FLUX.1';
  if (/qwen/i.test(b)) return 'Qwen-Image';
  if (/krea/i.test(b)) return 'Krea';
  if (/wan[-\s_]?2\.1/i.test(b)) return 'Wan 2.1';
  if (/wan[-\s_]?2\.2/i.test(b)) return 'Wan 2.2';
  if (/wan/i.test(b)) return 'Wan (other)';
  return 'Other / unstamped';
}

// NOTE: flux check comes before krea — flux-krea-dev is FLUX architecture.
export function modelFamily(model) {
  if (!model) return null;
  const s = [model.id, model.family, model.endpoint, model.name].filter(Boolean).join(' ');
  if (/flux/i.test(s)) return 'FLUX.1';
  if (/qwen/i.test(s)) return 'Qwen-Image';
  if (/krea/i.test(s)) return 'Krea';
  if (/wan[-\s_]?2\.1/i.test(s)) return 'Wan 2.1';
  if (/wan[-\s_]?2\.2/i.test(s)) return 'Wan 2.2';
  if (/wan/i.test(s)) return 'Wan (other)';
  return null;
}

export function modelIsVideo(model) {
  if (!model) return false;
  return /video/i.test([model.group_of, model.category].filter(Boolean).join(' '));
}

export function filterLoras(list, model, modelId) {
  const src = Array.isArray(list) ? list : [];
  if (!model && !modelId) return { shown: [...src], hidden: 0, family: null, exact: 0 };
  const fam = modelFamily(model);
  const wantVideo = modelIsVideo(model);
  const exact = [];
  const familial = [];
  for (const l of src) {
    if (modelId && l.muapi_model === modelId) {
      exact.push(l);
      continue;
    }
    if (fam && loraFamily(l) !== fam) continue;
    if ((l.pipeline === 'video-generation') !== wantVideo) continue;
    familial.push(l);
  }
  return { shown: [...exact, ...familial], hidden: src.length - exact.length - familial.length, family: fam, exact: exact.length };
}
