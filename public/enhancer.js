/**
 * Enhancer — prompt refinement via LLM (OpenRouter default)
 * Loaded after app.js, shares globals: API, currentModel, currentParams, currentSchema, allModels, showToast
 */
(function () {
  const DEFAULT_LLM = {
    providers: [
      { baseUrl: "https://openrouter.ai/api/v1", model: "cognitivecomputations/dolphin-mistral-24b-venice-edition:free", apiKey: "" },
      { baseUrl: "https://openrouter.ai/api/v1", model: "openrouter/free", apiKey: "" },
    ],
  };

  const TEMPLATE = `refine the following [Media Generation Type] prompt, specifically to optimize it for [Model]. This should include determining the optimal prompt length, or at least the ideal minimum and maximum word counts, determining whether the model excels with keyword based prompts or full narrative descriptions, what types of prompts work best (describe everything vs just describe movement, etc), whether it accepts timestamp direction (at 00:05, do this, at 00:10 do that, etc) and if it does add these timestamp directions based on the total length of the video (as input by the user) and estimating the time it would take for the described actions in the scene to take place, determine if a certain camera lens or videography style works well if called out for the specific model, translate any vague camera movement directions into videographer jargon (dolly out, orbital, chase cam, etc).  The video will be generated at [resolution] and [aspect ratio] (only include this if it would benefit the prompt for this model.  \nif [Model] includes audio generation, insert appropriate sound effect cues and format any dialogue into the most AI friendly format.`;

  function hasDialogueCues(s) {
    return /["\u201c\u201d].*["\u201c\u201d]|dialogue|says\s+["\u201c]|speaking|voice:/i.test(s);
  }

  function deriveMediaType(model) {
    if (!model) return "text-to-video";
    const id = model.id || "";
    const cat = (model.category || "").toLowerCase();
    if (id.includes("reference-to-video")) return "reference-to-video";
    if (id.includes("image-to-video") || id.includes("-i2v") || id.includes("i2v")) return "image-to-video";
    if (id.includes("text-to-video") || id.includes("-t2v")) return "text-to-video";
    if (id.includes("image-to-image") || id.includes("-i2i") || cat.includes("image to image")) return "image-to-image";
    if (cat.includes("text to image")) return "text-to-image";
    if (cat.includes("video to video") || cat.includes("video: edit")) return "video-to-video";
    if (cat.includes("audio")) return "audio generation";
    if (cat.includes("3d")) return "text-to-3d";
    return cat.replace(/ /g, "-") || "text-to-video";
  }

  function getEnhancerContext() {
    const model = window.currentModel || null;
    if (!model) return null;
    const params = window.currentParams || {};
    const schema = window.currentSchema || {};
    const def = schema.defaults || {};
    return {
      model: model.id,
      mediaType: deriveMediaType(model),
      aspectRatio: params.aspect_ratio || def.aspect_ratio || null,
      resolution: params.resolution || (params.width && params.height ? `${params.width}x${params.height}` : null) || def.resolution || null,
      duration: params.duration || def.duration || null,
      hasAudio: !!(model.id.includes("seedance") || model.id.includes("wan") || (model.group_of && model.group_of.includes("audio")) || (schema.params && schema.params.audio_url)),
    };
  }

  function buildSystemPrompt(raw, ctx) {
    let t = TEMPLATE
      .replace("[Media Generation Type]", ctx.mediaType)
      .replace("[Model]", ctx.model);
    // Conditional resolution/aspect
    const resAspect = [];
    if (ctx.resolution) resAspect.push(ctx.resolution);
    if (ctx.aspectRatio) resAspect.push(ctx.aspectRatio);
    if (resAspect.length) {
      t = t.replace("[resolution] and [aspect ratio]", resAspect.join(" and "));
    } else {
      // drop the sentence if no res/aspect
      t = t.replace(/The video will be generated at \[resolution\] and \[aspect ratio\][^\n]*\n?/, "");
    }
    // Audio clause only if hasAudio
    if (!ctx.hasAudio) {
      t = t.replace(/if \[Model\] includes audio generation,.*format\./, "").trim();
    } else {
      t = t.replace(/\[Model\]/g, ctx.model);
    }
    // Dialogue only if raw has cues — otherwise drop that clause
    if (!hasDialogueCues(raw)) {
      t = t.replace(/and format any dialogue into the most AI friendly format\./, " (dialogue formatting not needed for this prompt).");
    }
    // Video length timestamp logic
    if (ctx.duration && ctx.mediaType.includes("video")) {
      t += `\nVideo length: ${ctx.duration} seconds — add timestamp directions accordingly.`;
    }
    return t;
  }

  // Expose for preview
  window.getEnhancerContext = getEnhancerContext;
  window.buildSystemPrompt = buildSystemPrompt;

  async function getLLMConfig() {
    // Try localStorage first (wins on conflict)
    let local = null;
    try { local = JSON.parse(localStorage.getItem("muapi_llm_config") || "null"); } catch { local = null; }
    if (local && local.providers && local.providers.length) return local;

    // Try backend with 800ms timeout
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 800);
      const res = await fetch(API + "/llm-config", { signal: ctrl.signal });
      clearTimeout(to);
      if (res.ok) {
        const data = await res.json();
        if (data.config && data.config.providers) {
          // Masked keys from server are "***" — keep local real key if present
          return data.config;
        }
      }
    } catch { /* fallback */ }

    return local || DEFAULT_LLM;
  }

  async function saveLLMConfig(cfg) {
    localStorage.setItem("muapi_llm_config", JSON.stringify(cfg));
    // Fire-and-forget backend sync
    fetch(API + "/llm-config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ config: cfg }) }).catch(() => {});
  }

  function redact(cfg) {
    return {
      providers: (cfg.providers || []).map((p) => ({ ...p, apiKey: p.apiKey ? "***" : "" })),
    };
  }

  // Settings modal
  function renderSettings() {
    getLLMConfig().then((cfg) => {
      const list = document.getElementById("llmProvidersList");
      if (!list) return;
      list.innerHTML = "";
      (cfg.providers || []).forEach((p, idx) => {
        const row = document.createElement("div");
        row.className = "flex gap-2 items-start p-2 rounded bg-gray-900/50";
        row.draggable = true;
        row.dataset.idx = idx;
        row.innerHTML = `
          <span class="cursor-move text-gray-600 pt-2"><i class="fas fa-grip-lines"></i></span>
          <div class="flex-1 space-y-1">
            <input data-k="baseUrl" value="${p.baseUrl || ""}" placeholder="https://openrouter.ai/api/v1" class="input text-xs w-full">
            <input data-k="model" value="${p.model || ""}" placeholder="model id" class="input text-xs w-full">
            <input data-k="apiKey" type="password" value="${p.apiKey === "***" ? "" : (p.apiKey || "")}" placeholder="${p.apiKey === "***" ? "•••• (saved, leave blank to keep)" : "API key"}" class="input text-xs w-full">
          </div>
          <button data-remove="${idx}" class="icon-btn text-red-500" title="Remove"><i class="fas fa-trash"></i></button>
        `;
        list.appendChild(row);
      });
      // Remove handlers
      list.querySelectorAll("[data-remove]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const i = parseInt(btn.dataset.remove, 10);
          cfg.providers.splice(i, 1);
          if (!cfg.providers.length) cfg.providers.push({ baseUrl: "https://openrouter.ai/api/v1", model: "cognitivecomputations/dolphin-mistral-24b-venice-edition:free", apiKey: "" });
          saveLLMConfig(cfg);
          renderSettings();
        });
      });
      // Simple Up/Down via drag? Use click to move for now — drag reorders
      let dragIdx = null;
      list.querySelectorAll("[draggable]").forEach((row) => {
        row.addEventListener("dragstart", () => { dragIdx = parseInt(row.dataset.idx, 10); });
        row.addEventListener("dragover", (e) => e.preventDefault());
        row.addEventListener("drop", () => {
          const dropIdx = parseInt(row.dataset.idx, 10);
          if (dragIdx !== null && dragIdx !== dropIdx) {
            const [moved] = cfg.providers.splice(dragIdx, 1);
            cfg.providers.splice(dropIdx, 0, moved);
            saveLLMConfig(cfg);
            renderSettings();
          }
        });
      });
      // Live edit save on input blur
      list.querySelectorAll("input[data-k]").forEach((inp) => {
        inp.addEventListener("change", () => {
          const row = inp.closest("[data-idx]");
          const i = parseInt(row.dataset.idx, 10);
          const k = inp.dataset.k;
          cfg.providers[i][k] = inp.value.trim();
          saveLLMConfig(cfg);
        });
      });
    });
  }

  function openSettings() {
    renderSettings();
    document.getElementById("settingsModal").style.display = "flex";
  }
  function closeSettings() {
    document.getElementById("settingsModal").style.display = "none";
  }

  async function doEnhance(isMobile) {
    const inputId = isMobile ? "enhancerInputMobile" : "enhancerInput";
    const outputId = isMobile ? "enhancerOutputMobile" : "enhancerOutput";
    const wrapId = isMobile ? "enhancerOutputWrapMobile" : "enhancerOutputWrap";
    const metaId = isMobile ? "enhancerMetaMobile" : "enhancerMeta";
    const btnId = isMobile ? "btnEnhancePromptMobile" : "btnEnhancePrompt";

    const rawEl = document.getElementById(inputId);
    const raw = (rawEl ? rawEl.value : "").trim();
    if (!raw) { window.showToast && showToast("Enter a prompt to enhance", "error"); return; }
    const ctx = getEnhancerContext();
    if (!ctx || !ctx.model) { window.showToast && showToast("Select a model first", "error"); return; }

    const btn = document.getElementById(btnId);
    const orig = btn ? btn.innerHTML : "";
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i> Enhancing...'; }

    // Sync mirror input
    const mirrorId = isMobile ? "enhancerInput" : "enhancerInputMobile";
    const mirror = document.getElementById(mirrorId);
    if (mirror) mirror.value = raw;

    // Preview context
    const preview = document.getElementById("enhancerContextPreview");
    if (preview) {
      preview.textContent = `Model: ${ctx.model} | ${ctx.mediaType} | ${ctx.resolution || "auto"} | ${ctx.aspectRatio || "auto"}${ctx.duration ? " | " + ctx.duration + "s" : ""}${ctx.hasAudio ? " | audio" : ""}`;
      preview.classList.remove("hidden");
    }

    try {
      const res = await fetch(API + "/enhance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rawPrompt: raw, modelId: ctx.model, params: window.currentParams || {} }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || "Enhance failed");

      const outEl = document.getElementById(outputId);
      if (outEl) outEl.value = data.enhanced || "";
      const wrap = document.getElementById(wrapId);
      if (wrap) wrap.classList.remove("hidden");
      // Mirror to other pane
      const otherOut = document.getElementById(isMobile ? "enhancerOutput" : "enhancerOutputMobile");
      const otherWrap = document.getElementById(isMobile ? "enhancerOutputWrap" : "enhancerOutputWrapMobile");
      if (otherOut) otherOut.value = data.enhanced || "";
      if (otherWrap) otherWrap.classList.remove("hidden");

      const meta = document.getElementById(metaId);
      if (meta) meta.textContent = `via ${data.providerUsed || "?"} / ${data.modelUsed || "?"}${data.usage ? " — " + JSON.stringify(data.usage) : ""}`;
      const metaOther = document.getElementById(isMobile ? "enhancerMeta" : "enhancerMetaMobile");
      if (metaOther) metaOther.textContent = meta ? meta.textContent : "";

      // Auto-save to localStorage saved prompts (enhanced)
      try {
        const saved = JSON.parse(localStorage.getItem("muapi_saved") || "[]");
        saved.unshift({ prompt: data.enhanced, rawPrompt: raw, model: ctx.model, params: { ...window.currentParams }, kind: "enhanced", time: new Date().toISOString(), provider: data.providerUsed, llmModel: data.modelUsed });
        if (saved.length > 50) saved.pop();
        localStorage.setItem("muapi_saved", JSON.stringify(saved));
      } catch {}
      window.showToast && showToast("Enhanced ✓", "success");
    } catch (e) {
      window.showToast && showToast("Enhance failed: " + e.message, "error");
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = orig; }
    }
  }

  // Wire up once DOM ready
  function initEnhancer() {
    const byId = (id) => document.getElementById(id);
    // Enable/disable enhance buttons based on model selection
    const updateEnhanceBtns = () => {
      const hasModel = !!(window.currentModel && window.currentModel.id);
      const b1 = byId("btnEnhancePrompt"); if (b1) b1.disabled = !hasModel;
      const b2 = byId("btnEnhancePromptMobile"); if (b2) b2.disabled = !hasModel;
    };
    // Patch selectModel to update enhancer buttons
    const origSelect = window.selectModel;
    if (origSelect) {
      window.selectModel = async function (...a) { const r = await origSelect(...a); updateEnhanceBtns(); const ctx = getEnhancerContext(); const p = byId("enhancerContextPreview"); if (p && ctx) { p.textContent = `Model: ${ctx.model} | ${ctx.mediaType} | ${ctx.resolution || "auto"} | ${ctx.aspectRatio || "auto"}${ctx.duration ? " | "+ctx.duration+"s":""}${ctx.hasAudio?" | audio":""}`; p.classList.remove("hidden"); } return r; };
    }
    // Also poll for model changes
    setInterval(updateEnhanceBtns, 800);

    byId("btnEnhancePrompt") && byId("btnEnhancePrompt").addEventListener("click", () => doEnhance(false));
    byId("btnEnhancePromptMobile") && byId("btnEnhancePromptMobile").addEventListener("click", () => doEnhance(true));

    // Sync inputs
    const syncInputs = (a, b) => {
      const ea = byId(a), eb = byId(b);
      if (ea && eb) {
        ea.addEventListener("input", () => { eb.value = ea.value; });
        eb.addEventListener("input", () => { ea.value = eb.value; });
      }
    };
    syncInputs("enhancerInput", "enhancerInputMobile");

    // Use as Prompt
    const useEnhanced = (isMobile) => {
      const outId = isMobile ? "enhancerOutputMobile" : "enhancerOutput";
      const out = byId(outId);
      const val = out ? out.value : "";
      if (!val) return;
      const main = byId("promptInput");
      if (main) { main.value = val; if (window.updatePayloadPreview) updatePayloadPreview(); }
      window.showToast && showToast("Applied to prompt", "success");
    };
    byId("btnUseEnhanced") && byId("btnUseEnhanced").addEventListener("click", () => useEnhanced(false));
    byId("btnUseEnhancedMobile") && byId("btnUseEnhancedMobile").addEventListener("click", () => useEnhanced(true));

    // Copy
    byId("btnCopyEnhanced") && byId("btnCopyEnhanced").addEventListener("click", () => { const v = byId("enhancerOutput")?.value; if (v) navigator.clipboard.writeText(v); });
    byId("btnCopyEnhancedMobile") && byId("btnCopyEnhancedMobile").addEventListener("click", () => { const v = byId("enhancerOutputMobile")?.value; if (v) navigator.clipboard.writeText(v); });
    byId("btnSaveEnhanced") && byId("btnSaveEnhanced").addEventListener("click", () => {
      const v = byId("enhancerOutput")?.value;
      if (!v) return;
      try {
        const saved = JSON.parse(localStorage.getItem("muapi_saved") || "[]");
        saved.unshift({ prompt: v, model: window.currentModel?.id, params: { ...window.currentParams }, kind: "enhanced", time: new Date().toISOString() });
        localStorage.setItem("muapi_saved", JSON.stringify(saved));
        window.showToast && showToast("Saved", "success");
      } catch {}
    });

    // Mobile collapsible
    byId("btnToggleMobileEnhancer") && byId("btnToggleMobileEnhancer").addEventListener("click", () => {
      const body = byId("enhancerMobileBody");
      if (body) body.classList.toggle("hidden");
    });

    // Settings
    byId("btnSettings") && byId("btnSettings").addEventListener("click", openSettings);
    byId("closeSettingsModal") && byId("closeSettingsModal").addEventListener("click", closeSettings);
    byId("btnCancelSettings") && byId("btnCancelSettings").addEventListener("click", closeSettings);
    byId("settingsBackdrop") && byId("settingsBackdrop").addEventListener("click", closeSettings);
    byId("btnAddProvider") && byId("btnAddProvider").addEventListener("click", () => {
      getLLMConfig().then((cfg) => {
        cfg.providers.push({ baseUrl: "https://openrouter.ai/api/v1", model: "", apiKey: "" });
        saveLLMConfig(cfg);
        renderSettings();
      });
    });
    byId("btnSaveSettings") && byId("btnSaveSettings").addEventListener("click", async () => {
      const cfg = await getLLMConfig();
      // Collect from DOM
      const rows = document.querySelectorAll("#llmProvidersList [data-idx]");
      const providers = [];
      rows.forEach((row) => {
        const baseUrl = row.querySelector('[data-k="baseUrl"]')?.value.trim() || "";
        const model = row.querySelector('[data-k="model"]')?.value.trim() || "";
        const apiKey = row.querySelector('[data-k="apiKey"]')?.value || "";
        // If apiKey is empty and was "***", keep old
        const idx = parseInt(row.dataset.idx, 10);
        const old = cfg.providers[idx];
        const finalKey = apiKey === "" && old && old.apiKey === "***" ? "***" : apiKey;
        // Keep if at least model present
        if (model) providers.push({ baseUrl: baseUrl || "https://openrouter.ai/api/v1", model, apiKey: finalKey });
      });
      if (!providers.length) { window.showToast && showToast("Add at least one model", "error"); return; }
      const next = { providers };
      await saveLLMConfig(next);
      // Also try to persist to server with real keys (replace *** with old real key if needed)
      // Fetch current real config from localStorage backup before masking
      try {
        const real = JSON.parse(localStorage.getItem("muapi_llm_config") || "null");
        if (real) {
          // Merge real keys where placeholder
          next.providers.forEach((p, i) => { if (p.apiKey === "***" && real.providers[i]) p.apiKey = real.providers[i].apiKey; });
          localStorage.setItem("muapi_llm_config", JSON.stringify(next));
        }
      } catch {}
      const s = document.getElementById("settingsStatus");
      if (s) { s.textContent = "Saved — will try backend sync, falls back to browser"; s.classList.remove("hidden"); setTimeout(() => s.classList.add("hidden"), 2000); }
      closeSettings();
      window.showToast && showToast("LLM settings saved", "success");
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initEnhancer);
  else initEnhancer();
})();
