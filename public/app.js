/**
 * MuAPI Prompt Generator - Frontend App
 */

const API = '/api';
let allModels = [];
let currentModel = null;
let currentParams = {};
let currentTab = 'image';
let pollTimer = null;
let history = [];

// ── Init ──
document.addEventListener('DOMContentLoaded', async () => {
  await loadModels();
  setupEventListeners();
  updateConnectionStatus(true);
});

// ── Load models from D1 via Worker ──
async function loadModels() {
  try {
    const res = await fetch(`${API}/models?limit=1000`);
    const data = await res.json();
    allModels = data.models || [];
    document.getElementById('modelCount').textContent = `${allModels.length} models`;
    filterModelsByTab();
  } catch (e) {
    console.error('Failed to load models:', e);
    document.getElementById('modelCount').textContent = 'offline';
  }
}

// ── Filter models by active tab ──
function filterModelsByTab() {
  const groupMap = {
    image: ['image'],
    video: ['video'],
    other: ['audio', 'text', '3d', 'other', null],
  };
  const groups = groupMap[currentTab] || [];
  const filtered = allModels.filter(m => groups.includes(m.group_of));
  populateModelDropdown(filtered);
}

// ── Populate model dropdown ──
function populateModelDropdown(models) {
  const dropdown = document.getElementById('modelDropdown');
  const select = document.getElementById('modelSelect');

  // Group by category
  const byCategory = {};
  for (const m of models) {
    const cat = m.category || 'Other';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(m);
  }

  // Sort categories
  const sortedCats = Object.keys(byCategory).sort();

  // Build dropdown HTML
  let html = '';
  for (const cat of sortedCats) {
    const catModels = byCategory[cat].sort((a, b) => a.name.localeCompare(b.name));
    html += `<div class="px-3 py-1.5 text-[10px] uppercase tracking-wider text-gray-600 font-semibold bg-gray-950 sticky top-0">${cat} (${catModels.length})</div>`;
    for (const m of catModels) {
      const costStr = m.cost > 0 ? `$${m.cost}` : 'Free';
      html += `<div class="dropdown-item" data-id="${m.id}" data-category="${m.category}">
        <span class="truncate">${m.id}</span>
        <span class="text-[10px] text-gray-600 ml-2 shrink-0">${costStr}</span>
      </div>`;
    }
  }
  dropdown.innerHTML = html || '<div class="px-3 py-4 text-sm text-gray-600">No models found</div>';

  // Build select (hidden, for form submission)
  select.innerHTML = '';
  for (const m of models.sort((a, b) => a.name.localeCompare(b.name))) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = `${m.id} (${m.cost > 0 ? '$' + m.cost : 'Free'})`;
    select.appendChild(opt);
  }

  // Click handlers for dropdown items
  dropdown.querySelectorAll('.dropdown-item').forEach(item => {
    item.addEventListener('click', () => {
      selectModel(item.dataset.id);
      dropdown.classList.add('hidden');
      document.getElementById('modelSearch').value = item.querySelector('span').textContent.trim();
    });
  });
}

// ── Select a model ──
async function selectModel(modelId) {
  currentModel = allModels.find(m => m.id === modelId);
  if (!currentModel) return;

  // Update UI
  document.getElementById('modelSearch').value = modelId;
  document.getElementById('modelSelect').value = modelId;

  const info = document.getElementById('modelInfo');
  info.classList.remove('hidden');
  document.getElementById('modelCategory').textContent = currentModel.category;
  document.getElementById('modelCost').textContent = currentModel.cost > 0
    ? `~$${currentModel.cost} per call`
    : 'Free';

  // Load params
  try {
    const res = await fetch(`${API}/models/${encodeURIComponent(modelId)}`);
    const data = await res.json();
    currentParams = {};
    if (data.paramSchema) {
      renderParams(data.paramSchema);
      document.getElementById('paramsContainer').classList.remove('hidden');
    } else {
      document.getElementById('paramsContainer').classList.add('hidden');
    }
  } catch (e) {
    console.error('Failed to load params:', e);
    document.getElementById('paramsContainer').classList.add('hidden');
  }

  updatePayloadPreview();
  document.getElementById('btnGenerate').disabled = false;
}

// ── Render parameter form ──
function renderParams(schema) {
  const form = document.getElementById('paramsForm');
  form.innerHTML = '';
  currentParams = schema.defaults || {};

  const params = schema.params || {};
  const entries = Object.entries(params);

  // Sort: prompt first, then required, then optional
  entries.sort(([aName, aSpec], [bName, bSpec]) => {
    if (aName === 'prompt') return -1;
    if (bName === 'prompt') return 1;
    if (aSpec.required && !bSpec.required) return -1;
    if (!aSpec.required && bSpec.required) return 1;
    return aName.localeCompare(bName);
  });

  for (const [name, spec] of entries) {
    // Skip prompt (we have a dedicated prompt textarea)
    if (name === 'prompt') continue;

    const wrapper = document.createElement('div');
    const id = `param_${name}`;

    const labelHtml = `<label class="param-label" for="${id}">
      ${spec.title || name}
      ${spec.required ? '<span class="required">*required</span>' : ''}
    </label>`;

    const descHtml = spec.description ? `<p class="param-description">${spec.description}</p>` : '';

    let inputHtml = '';

    // Enum/select
    if (spec.options && spec.options.length > 0) {
      const opts = spec.options.map(o => {
        const selected = (schema.defaults?.[name] === o || spec.default === o) ? 'selected' : '';
        return `<option value="${o}" ${selected}>${o}</option>`;
      }).join('');
      inputHtml = `<select id="${id}" class="param-input" data-param="${name}">
        ${!spec.required ? '<option value="">--</option>' : ''}
        ${opts}
      </select>`;
    }
    // Range (min/max integer)
    else if (spec.type === 'number' && spec.min !== undefined && spec.max !== undefined) {
      const def = schema.defaults?.[name] ?? spec.default ?? spec.min;
      inputHtml = `<div class="flex items-center gap-2">
        <input id="${id}" type="range" class="flex-1 accent-purple-500" data-param="${name}"
               min="${spec.min}" max="${spec.max}" value="${def}" step="1">
        <span class="range-value" id="${id}_val">${def}</span>
      </div>`;
    }
    // Number
    else if (spec.type === 'number') {
      const def = schema.defaults?.[name] ?? spec.default ?? '';
      inputHtml = `<input id="${id}" type="number" class="param-input" data-param="${name}"
                    value="${def}" ${spec.min !== undefined ? `min="${spec.min}"` : ''} ${spec.max !== undefined ? `max="${spec.max}"` : ''}>`;
    }
    // Boolean
    else if (spec.type === 'boolean') {
      const def = schema.defaults?.[name] ?? spec.default ?? false;
      inputHtml = `<label class="flex items-center gap-2 cursor-pointer">
        <input id="${id}" type="checkbox" class="accent-purple-500" data-param="${name}" ${def ? 'checked' : ''}>
        <span class="text-xs text-gray-400">${def ? 'Enabled' : 'Disabled'}</span>
      </label>`;
    }
    // URL
    else if (spec.format === 'uri' || name.includes('url') || name.includes('image')) {
      inputHtml = `<input id="${id}" type="url" class="param-input" data-param="${name}"
                    placeholder="https://..." value="${schema.defaults?.[name] || ''}">`;
    }
    // String (default)
    else {
      const def = schema.defaults?.[name] ?? spec.default ?? '';
      inputHtml = `<input id="${id}" type="text" class="param-input" data-param="${name}" value="${def}">`;
    }

    wrapper.innerHTML = labelHtml + inputHtml + descHtml;
    form.appendChild(wrapper);

    // Wire up change events
    const input = wrapper.querySelector(`#${id}`);
    if (input) {
      const handler = () => {
        let val;
        if (input.type === 'checkbox') {
          val = input.checked;
        } else if (input.type === 'range') {
          val = parseInt(input.value);
          document.getElementById(`${id}_val`).textContent = val;
        } else if (input.type === 'number') {
          val = input.value ? parseFloat(input.value) : undefined;
        } else {
          val = input.value || undefined;
        }
        if (val !== undefined && val !== '') {
          currentParams[name] = val;
        } else {
          delete currentParams[name];
        }
        updatePayloadPreview();
      };
      input.addEventListener('input', handler);
      input.addEventListener('change', handler);
    }
  }
}

// ── Update API payload preview ──
function updatePayloadPreview() {
  const prompt = document.getElementById('promptInput').value || '';
  const payload = { prompt, ...currentParams };
  // Remove empty/undefined
  for (const [k, v] of Object.entries(payload)) {
    if (v === undefined || v === '') delete payload[k];
  }
  document.getElementById('payloadPreview').textContent = JSON.stringify(payload, null, 2);
}

// ── Generate ──
async function generate() {
  if (!currentModel) return;

  const prompt = document.getElementById('promptInput').value.trim();
  if (!prompt) {
    document.getElementById('promptInput').focus();
    return;
  }

  const btn = document.getElementById('btnGenerate');
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner inline-block mr-2"></div> Generating...';

  showStatus('Submitting...', 'Sending request to MuAPI', true);
  hideOutput();

  const params = { prompt, ...currentParams };
  // Clean empty
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '') delete params[k];
  }

  try {
    const res = await fetch(`${API}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelId: currentModel.id, params }),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || data.details?.detail || 'Generation failed');
    }

    showStatus('Processing...', `Request ID: ${data.requestId}`, true);
    pollForResult(data.requestId, data.cost);

  } catch (e) {
    showStatus('Error', e.message, false);
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-play mr-2"></i> Generate';
  }
}

// ── Poll for result ──
function pollForResult(requestId, initialCost) {
  const startTime = Date.now();

  if (pollTimer) clearInterval(pollTimer);

  pollTimer = setInterval(async () => {
    try {
      const res = await fetch(`${API}/predictions/${requestId}`);
      const data = await res.json();

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      if (data.status === 'completed') {
        clearInterval(pollTimer);
        showStatus('Completed', `Done in ${elapsed}s`, false);
        showOutput(data.outputs, initialCost, elapsed);
        addToHistory(requestId, data.outputs, initialCost, elapsed);

        const btn = document.getElementById('btnGenerate');
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-play mr-2"></i> Generate';

      } else if (data.status === 'failed') {
        clearInterval(pollTimer);
        showStatus('Failed', data.error || 'Generation failed', false);

        const btn = document.getElementById('btnGenerate');
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-play mr-2"></i> Generate';

      } else {
        const pct = data.status === 'processing' ? 60 : data.status === 'queued' ? 20 : 40;
        showStatus(capitalize(data.status), `${elapsed}s elapsed`, true);
        updateProgress(pct);
      }
    } catch (e) {
      // Network error - keep polling
    }
  }, 2500);
}

// ── UI Helpers ──
function showStatus(text, detail, showSpinner) {
  const card = document.getElementById('statusCard');
  card.classList.remove('hidden');
  document.getElementById('statusText').textContent = text;
  document.getElementById('statusDetail').textContent = detail;
  document.getElementById('statusSpinner').classList.toggle('hidden', !showSpinner);
  document.getElementById('progressBar').classList.toggle('hidden', !showSpinner);
}

function updateProgress(pct) {
  document.getElementById('progressFill').style.width = `${pct}%`;
}

function hideOutput() {
  document.getElementById('outputCard').classList.add('hidden');
  document.getElementById('outputContent').innerHTML = '';
}

function showOutput(outputs, cost, elapsed) {
  if (!outputs || outputs.length === 0) return;

  const card = document.getElementById('outputCard');
  card.classList.remove('hidden');
  const content = document.getElementById('outputContent');
  const meta = document.getElementById('outputMeta');

  const url = outputs[0];
  const isVideo = url.match(/\.(mp4|webm|mov)$/i) || url.includes('video');

  if (isVideo) {
    content.innerHTML = `<video src="${url}" controls autoplay loop class="max-w-full max-h-[512px] rounded-lg"></video>`;
  } else {
    content.innerHTML = `<img src="${url}" alt="Generated output" class="max-w-full max-h-[512px] rounded-lg">`;
  }

  const costStr = cost?.amount_usd ? `$${cost.amount_usd.toFixed(4)}` : 'N/A';
  meta.innerHTML = `
    <span><i class="fas fa-clock mr-1"></i>${elapsed}s</span>
    <span><i class="fas fa-dollar-sign mr-1"></i>${costStr}</span>
    <span><i class="fas fa-images mr-1"></i>${outputs.length} output${outputs.length > 1 ? 's' : ''}</span>
  `;

  // Store URL for copy/download
  card.dataset.url = url;
}

function addToHistory(requestId, outputs, cost, elapsed) {
  const url = outputs?.[0];
  if (!url) return;

  history.unshift({
    requestId, url, cost: cost?.amount_usd, elapsed,
    model: currentModel?.id, time: new Date().toLocaleTimeString(),
  });

  if (history.length > 20) history.pop();
  renderHistory();
}

function renderHistory() {
  const list = document.getElementById('historyList');
  if (history.length === 0) {
    list.innerHTML = '<p class="text-xs text-gray-600">No generations yet.</p>';
    return;
  }

  list.innerHTML = history.map((h, i) => {
    const isVideo = h.url.match(/\.(mp4|webm|mov)$/i);
    const thumb = isVideo
      ? `<div class="w-10 h-10 rounded bg-gray-800 flex items-center justify-center"><i class="fas fa-video text-gray-600 text-xs"></i></div>`
      : `<img src="${h.url}" class="w-10 h-10 rounded object-cover" loading="lazy">`;
    return `<div class="history-item" data-index="${i}">
      ${thumb}
      <div class="flex-1 min-w-0">
        <div class="text-xs text-gray-300 truncate">${h.model}</div>
        <div class="text-[10px] text-gray-600">${h.time} · ${h.elapsed}s · $${(h.cost || 0).toFixed(4)}</div>
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('.history-item').forEach(item => {
    item.addEventListener('click', () => {
      const h = history[item.dataset.index];
      if (h) window.open(h.url, '_blank');
    });
  });
}

function updateConnectionStatus(connected) {
  const el = document.getElementById('connectionStatus');
  el.innerHTML = connected
    ? '<i class="fas fa-circle text-green-500 text-[8px]"></i>'
    : '<i class="fas fa-circle text-red-500 text-[8px]"></i>';
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

// ── Event Listeners ──
function setupEventListeners() {
  // Tab switching
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentTab = btn.dataset.tab;
      filterModelsByTab();
    });
  });

  // Model search
  const search = document.getElementById('modelSearch');
  const dropdown = document.getElementById('modelDropdown');

  search.addEventListener('focus', () => dropdown.classList.remove('hidden'));
  search.addEventListener('input', () => {
    const q = search.value.toLowerCase();
    dropdown.querySelectorAll('.dropdown-item').forEach(item => {
      const name = item.querySelector('span').textContent.toLowerCase();
      item.style.display = name.includes(q) ? '' : 'none';
    });
    // Show/hide category headers
    dropdown.querySelectorAll('.sticky').forEach(header => {
      const next = header.nextElementSibling;
      if (!next) return;
      let hasVisible = false;
      let el = header.nextElementSibling;
      while (el && !el.classList.contains('sticky')) {
        if (el.style.display !== 'none') hasVisible = true;
        el = el.nextElementSibling;
      }
      header.style.display = hasVisible ? '' : 'none';
    });
    dropdown.classList.remove('hidden');
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.relative')) {
      dropdown.classList.add('hidden');
    }
  });

  // Prompt input
  document.getElementById('promptInput').addEventListener('input', updatePayloadPreview);

  // Generate button
  document.getElementById('btnGenerate').addEventListener('click', generate);

  // Keyboard shortcut
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      generate();
    }
  });

  // Copy buttons
  document.getElementById('btnCopyUrl')?.addEventListener('click', () => {
    const url = document.getElementById('outputCard')?.dataset.url;
    if (url) navigator.clipboard.writeText(url);
  });

  document.getElementById('btnDownload')?.addEventListener('click', () => {
    const url = document.getElementById('outputCard')?.dataset.url;
    if (url) window.open(url, '_blank');
  });

  document.getElementById('btnOpenNew')?.addEventListener('click', () => {
    const url = document.getElementById('outputCard')?.dataset.url;
    if (url) window.open(url, '_blank');
  });

  document.getElementById('btnCopyPayload')?.addEventListener('click', () => {
    const text = document.getElementById('payloadPreview').textContent;
    navigator.clipboard.writeText(text);
  });

  // Clear button
  document.getElementById('btnClear')?.addEventListener('click', () => {
    document.getElementById('promptInput').value = '';
    updatePayloadPreview();
  });

  // Enhance button (placeholder)
  document.getElementById('btnEnhance')?.addEventListener('click', () => {
    const prompt = document.getElementById('promptInput').value;
    if (!prompt) return;
    // Simple enhancement: add quality keywords
    const enhanced = prompt + ', ultra-detailed, high quality, sharp focus, 8k';
    document.getElementById('promptInput').value = enhanced;
    updatePayloadPreview();
  });
}
