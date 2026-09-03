/**
 * MuAPI LoRA Quick Picker — HuggingFace D33pStateTech
 * Shows HF LoRAs discovered via API and lets user copy/fill LoRA fields for current model.
 * Supports multiple LoRA field names: loras (array), lora_url, lora_list, etc.
 */
(function(){
  const USER_LORAS = [
    {
      id: "D33pStateTech/d33pstateten",
      name: "d33pstateten",
      base_model: "krea/Krea-2-Raw",
      pipeline: "text-to-image",
      private: true,
      instance_prompt: "aznten",
      file: "pytorch_lora_weights.safetensors",
      repo_url: "https://huggingface.co/D33pStateTech/d33pstateten",
      file_url: "https://huggingface.co/D33pStateTech/d33pstateten/resolve/main/pytorch_lora_weights.safetensors",
      suggested_target: "krea-v2-turbo-lora (loras) or any Krea-2 via diffusers",
      replicate_model: "krea/krea-2-large",
      muapi_model: "krea-v2-turbo-lora",
      note: "Krea-2-Raw LoRA, trigger aznten. For MuAPI use krea-v2-turbo-lora → loras: [{\"path\":\"...\",\"scale\":1}]"
    },
    {
      id: "D33pStateTech/d33pstateLora",
      name: "d33pstateLora",
      base_model: "black-forest-labs/FLUX.1-dev",
      pipeline: "text-to-image",
      private: false,
      instance_prompt: "asian ten",
      file: "flux-asian-ten-v2-000024.safetensors",
      repo_url: "https://huggingface.co/D33pStateTech/d33pstateLora",
      file_url: "https://huggingface.co/D33pStateTech/d33pstateLora/resolve/main/flux-asian-ten-v2-000024.safetensors",
      suggested_target: "flux-dev-lora or flux-1-dev-style-lora-inference (lora_url) / aznten_replicate (extra_lora)",
      muapi_model: "flux-1-dev-style-lora-inference",
      note: "FLUX.1-dev LoRA, trigger 'asian ten'. Use as lora_url on MuAPI or extra_lora on Replicate AZNTEN."
    },
    {
      id: "D33pStateTech/asian-ten-wan21-lora",
      name: "asian-ten-wan21-lora",
      base_model: "Wan-AI/Wan2.1-T2V-14B",
      pipeline: "video-generation",
      private: false,
      instance_prompt: "",
      file: "asian_ten_wan21.safetensors",
      repo_url: "https://huggingface.co/D33pStateTech/asian-ten-wan21-lora",
      file_url: "https://huggingface.co/D33pStateTech/asian-ten-wan21-lora/resolve/main/asian_ten_wan21.safetensors",
      suggested_target: "wan2.1-lora-t2v / wan2.1-lora-i2v / wavespeedai/wan-2.1-t2v-480p (lora_weights)",
      muapi_model: "wan2.1-lora-t2v",
      note: "Wan2.1 T2V LoRA — use as lora_weights on wavespeedai/wan-2.1-t2v-480p or MuAPI wan2.1-lora-*"
    }
  ];

  function copyText(t, label){
    navigator.clipboard.writeText(t).then(()=> {
      if(window.showToast) showToast(label + ' copied', 'success');
      else alert(label + ' copied');
    });
  }

  function findLoraFieldForCurrentModel(){
    // Try to detect currentSchema (from window.currentSchema or app.js globals)
    const schema = window.currentSchema || null;
    if(!schema || !schema.params) return null;
    const params = schema.params;
    // Priority order for MuAPI lora fields
    const candidates = [
      {key:'loras', type:'array'}, // krea-v2-turbo-lora
      {key:'lora_url', type:'string'}, // flux-1-dev-style-lora-inference
      {key:'lora_list', type:'array'}, // flux-2-klein
      {key:'lora_weights', type:'string'}, // wavespeed
      {key:'extra_lora', type:'string'},
      {key:'lora_scale', type:'number'},
    ];
    for(const c of candidates){
      if(params[c.key]){
        return c.key;
      }
    }
    // Fallback: any key containing lora
    for(const k of Object.keys(params)){
      if(k.toLowerCase().includes('lora')){
        return k;
      }
    }
    return null;
  }

  function fillLoraForCurrentModel(repoUrl, fileUrl){
    const curModel = window.currentModel;
    const field = findLoraFieldForCurrentModel();
    if(!curModel){
      copyText(repoUrl, 'Repo URL');
      if(window.showToast) showToast('Select a model first — copied repo URL', 'error');
      return;
    }
    if(!field){
      copyText(repoUrl, 'Repo URL');
      if(window.showToast) showToast('No LoRA field for this model — copied repo URL', 'error');
      return;
    }
    // Determine value to fill based on field type
    const schema = window.currentSchema;
    const spec = schema.params[field];
    let valueToFill = repoUrl;
    let displayLabel = field;

    // Handle array types (loras, lora_list)
    if(spec && spec.type==='array'){
      // For loras: expected [{path: url, scale: 1.0}]
      // For lora_list: similar but may be LoraItem
      // We'll set as array with one entry
      const scale = 1.0;
      // Decide which URL to use: repo_url is most compatible, but some expect direct file_url
      // Provide repo_url by default, as Replicate/MuAPI can resolve repo
      valueToFill = [{ path: repoUrl, scale: scale }];
      // Special for lora_list which may expect {path, scale} as well
      // For krea-v2-turbo-lora, example: [{'path': '...', 'scale': 1.0}]
      // We'll use that
    } else if(spec && spec.type==='string'){
      // For lora_url, lora_weights, extra_lora
      // Use repo_url (or file_url if the field expects direct file)
      // For wavespeedai, lora_weights can be HF repo URL
      // For flux-1-dev-style-lora-inference, lora_url expects direct .safetensors URL? The description says "The LoRA file URL" — could be direct.
      // We'll use file_url for direct file fields, repo_url for repo fields
      // Heuristic: if field is lora_weights or lora_url and file_url ends with .safetensors, use file_url for direct
      if(field==='lora_weights' || field==='lora_url'){
        // Prefer file_url if available and field description mentions file URL
        // But repo_url also works for many. We'll use file_url for direct to be safe, but also provide repo_url as alternative
        // Default to repo_url for compatibility, but if user wants file, they can copy file_url
        valueToFill = fileUrl || repoUrl;
      } else {
        valueToFill = repoUrl;
      }
    }

    // Try to set via currentParams and UI
    // For muapi, currentParams is object, and renderParams will handle array vs string
    // We need to set window.currentParams[field] and re-render
    try{
      if(window.currentParams){
        window.currentParams[field] = valueToFill;
      }
      // Try to find input element for that field
      // For array fields, the UI may be more complex (e.g., loras is array, renders as???)
      // For now, just update currentParams and refresh payload preview
      if(window.updatePayloadPreview) window.updatePayloadPreview();
      // Try to find and update the input element if it exists
      const input = document.querySelector(`[data-param="${field}"]`);
      if(input){
        if(input.tagName==='SELECT'){
          // not expected for lora
        } else if(input.type==='checkbox'){
          // no
        } else {
          // For string fields, set value
          if(typeof valueToFill === 'string'){
            input.value = valueToFill;
            input.dispatchEvent(new Event('input', {bubbles:true}));
            input.dispatchEvent(new Event('change', {bubbles:true}));
          } else if(Array.isArray(valueToFill)){
            // For array, the UI may be a custom component, try to trigger re-render
            // Force re-render of params
            if(window.currentSchema){
              // Re-render params to show updated value
              // The function renderParams is in app.js, but not exposed globally. Try to trigger selectModel reload?
              // Instead, just show toast and copy
            }
            // Also copy the JSON to clipboard for manual paste
            copyText(JSON.stringify(valueToFill), field);
            if(window.showToast) showToast(`Filled ${field} with LoRA array — also copied JSON`, 'success');
            return;
          }
        }
        input.focus();
        input.select();
      }
      if(window.showToast) showToast(`Filled ${field} with LoRA`, 'success');
      // Also copy to clipboard for convenience
      // Don't auto-copy, just fill
    } catch(e){
      console.error(e);
      copyText(typeof valueToFill==='string'? valueToFill : JSON.stringify(valueToFill), field);
    }
  }

  function renderLoraList(){
    const list = document.getElementById('loraListMuapi');
    const hint = document.getElementById('loraHintMuapi');
    if(!list) return;
    list.innerHTML = USER_LORAS.map(l => `
      <div class="p-2 rounded-lg bg-gray-800/50 border border-gray-700 hover:border-purple-600/50 transition-colors">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1.5">
              <span class="text-xs font-semibold text-gray-200 truncate">${l.name}</span>
              ${l.private ? '<span class="text-[9px] bg-amber-900/50 text-amber-300 border border-amber-800 px-1.5 py-0.5 rounded-full">Private</span>' : '<span class="text-[9px] bg-emerald-900/30 text-emerald-300 border border-emerald-800 px-1.5 py-0.5 rounded-full">Public</span>'}
              <span class="text-[10px] text-gray-500 truncate">${l.base_model}</span>
            </div>
            <div class="text-[10px] text-gray-500 mt-0.5 truncate">${l.id} • ${l.file}</div>
            <div class="mt-1 flex items-center gap-1.5">
              <span class="text-[10px] text-gray-500">Trigger:</span>
              ${l.instance_prompt ? `<code class="text-[11px] font-bold bg-fuchsia-900/40 border border-fuchsia-700 text-fuchsia-300 px-1.5 py-0.5 rounded">${l.instance_prompt}</code><button data-copy-trigger="${l.id}" class="icon-btn !w-6 !h-6" title="Copy trigger"><i class="fas fa-copy text-[9px]"></i></button>` : `<span class="text-[10px] text-gray-600 italic">No trigger — general style</span>`}
            </div>
            <div class="text-[10px] text-gray-400 mt-1 line-clamp-2">${l.note}</div>
            <div class="text-[10px] text-purple-300 mt-1">→ ${l.suggested_target}</div>
          </div>
          <span class="text-[10px] text-gray-600">${l.pipeline==='video-generation' ? '<i class="fas fa-video"></i>' : '<i class="fas fa-image"></i>'}</span>
        </div>
        <div class="mt-2 space-y-1.5">
          <div class="flex gap-1">
            <code class="flex-1 text-[10px] bg-gray-900 border border-gray-700 rounded px-2 py-1 truncate">${l.repo_url}</code>
            <button data-copy-repo="${l.id}" class="icon-btn !w-7 !h-7" title="Copy repo URL"><i class="fas fa-copy text-[10px]"></i></button>
            <button data-fill-repo="${l.id}" class="btn-primary-sm !px-2 !py-1 text-[10px]">Fill</button>
          </div>
          <div class="flex gap-1">
            <code class="flex-1 text-[10px] bg-gray-900 border border-gray-700 rounded px-2 py-1 truncate">${l.file_url}</code>
            <button data-copy-file="${l.id}" class="icon-btn !w-7 !h-7" title="Copy .safetensors URL"><i class="fas fa-file text-[10px]"></i></button>
            <button data-fill-file="${l.id}" class="btn-secondary !px-2 !py-1 text-[10px]">Fill file</button>
          </div>
        </div>
      </div>
    `).join('');
    if(hint) hint.classList.remove('hidden');
    // Wire events
    list.querySelectorAll('[data-copy-repo]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const id=btn.getAttribute('data-copy-repo');
        const l=USER_LORAS.find(x=>x.id===id);
        if(l) copyText(l.repo_url, 'Repo URL');
      });
    });
    list.querySelectorAll('[data-copy-file]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const id=btn.getAttribute('data-copy-file');
        const l=USER_LORAS.find(x=>x.id===id);
        if(l) copyText(l.file_url, 'File URL');
      });
    });
    list.querySelectorAll('[data-copy-trigger]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const id=btn.getAttribute('data-copy-trigger');
        const l=USER_LORAS.find(x=>x.id===id);
        if(l && l.instance_prompt) copyText(l.instance_prompt, 'Trigger');
      });
    });
    list.querySelectorAll('[data-fill-repo]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const id=btn.getAttribute('data-fill-repo');
        const l=USER_LORAS.find(x=>x.id===id);
        if(l) fillLoraForCurrentModel(l.repo_url, l.file_url);
      });
    });
    list.querySelectorAll('[data-fill-file]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const id=btn.getAttribute('data-fill-file');
        const l=USER_LORAS.find(x=>x.id===id);
        if(l) fillLoraForCurrentModel(l.file_url, l.repo_url);
      });
    });
  }

  function initLoraPicker(){
    const btn=document.getElementById('btnToggleLoraListMuapi');
    const list=document.getElementById('loraListMuapi');
    if(btn && list){
      btn.addEventListener('click', ()=>{
        const hidden=list.classList.contains('hidden');
        if(hidden){
          list.classList.remove('hidden');
          document.getElementById('loraHintMuapi')?.classList.remove('hidden');
          btn.innerHTML='<i class="fas fa-chevron-up mr-1"></i> Hide LoRAs';
          renderLoraList();
        } else {
          list.classList.add('hidden');
          document.getElementById('loraHintMuapi')?.classList.add('hidden');
          btn.innerHTML='<i class="fas fa-chevron-down mr-1"></i> Show LoRAs';
        }
      });
    }
    // Re-render hint when model changes
    const origSelect = window.selectModel;
    if(origSelect){
      window.selectModel = async function(...a){
        const r=await origSelect(...a);
        if(list && !list.classList.contains('hidden')) renderLoraList();
        return r;
      };
    }
  }

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', initLoraPicker);
  else initLoraPicker();

  // Expose for debugging
  window.USER_LORAS = USER_LORAS;
})();
