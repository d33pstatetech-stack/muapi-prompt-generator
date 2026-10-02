import { useEffect } from 'react';

function isVideoUrl(u) {
  return /\.(mp4|webm|mov)$/i.test(u || '') || (u || '').includes('video');
}

function fmtCost(c) {
  if (c == null || c === '') return null;
  if (typeof c === 'number') return Number.isFinite(c) ? `$${c.toFixed(4)}` : String(c);
  if (typeof c === 'string') return c.startsWith('$') ? c : `$${c}`;
  if (typeof c === 'object') {
    const v = c.amount_usd ?? c.amount ?? c.cost ?? null;
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? `$${n.toFixed(4)}` : String(v);
  }
  return String(c);
}

function fmtParams(p) {
  if (p == null) return null;
  if (typeof p === 'string') return p.slice(0, 2000) || null;
  try {
    const s = JSON.stringify(p, null, 2);
    return s ? s.slice(0, 2000) : null;
  } catch {
    return null;
  }
}

function fmtLoras(l) {
  if (l == null) return null;
  if (typeof l === 'string') return l.slice(0, 1000) || null;
  if (Array.isArray(l)) {
    if (!l.length) return null;
    try {
      return JSON.stringify(l, null, 2).slice(0, 2000);
    } catch {
      return l.map(String).join(', ').slice(0, 1000) || null;
    }
  }
  if (typeof l === 'object') {
    const keys = Object.keys(l);
    if (!keys.length) return null;
    try {
      return JSON.stringify(l, null, 2).slice(0, 2000);
    } catch {
      return keys.join(', ').slice(0, 1000);
    }
  }
  return String(l).slice(0, 1000);
}

// Media viewer modal: main pane img/video + sidebar metadata.
// Renders only fields present on the item object; never crashes on missing.
export default function MediaViewer({ item, onClose }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && onClose) onClose();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  if (!item || typeof item !== 'object') return null;
  const url = item.url || (Array.isArray(item.urls) ? item.urls[0] : null) || '';
  if (!url) return null;
  const video = isVideoUrl(url);
  const model = item.model || item.modelId || item.target_model || null;
  const prompt = item.prompt || null;
  const paramsStr = fmtParams(item.params);
  const lorasStr = fmtLoras(item.loras ?? item.lora_list);
  const rating = item.rating ?? null;
  const cost = fmtCost(item.cost ?? item.cost_hint ?? null);
  const timestamp = item.timestamp || item.time || item.created_at || null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && onClose) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Media viewer"
    >
      <div className="flex flex-col md:flex-row w-full max-w-5xl max-h-[90vh] bg-gray-900 border border-gray-700 rounded-xl overflow-hidden">
        <div className="flex-1 min-w-0 bg-black flex items-center justify-center">
          {video ? (
            <video src={url} controls autoPlay loop className="w-full max-h-[80vh] object-contain" />
          ) : (
            <img src={url} alt="" className="w-full max-h-[80vh] object-contain" />
          )}
        </div>
        <div className="w-full md:w-80 flex-none p-4 overflow-y-auto space-y-3 text-xs border-t md:border-t-0 md:border-l border-gray-800">
          <div className="flex items-center justify-between gap-2">
            <span className="text-gray-400 uppercase tracking-wide text-[10px]">Details</span>
            <div className="flex gap-1.5">
              <a
                href={url}
                download
                title="Download"
                aria-label="Download"
                className="w-8 h-8 rounded-lg bg-gray-900 border border-gray-700 text-gray-400 hover:text-white inline-flex items-center justify-center"
              >
                <i className="fas fa-download text-xs"></i>
              </a>
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                title="Open full size"
                aria-label="Open full size"
                className="w-8 h-8 rounded-lg bg-gray-900 border border-gray-700 text-gray-400 hover:text-white inline-flex items-center justify-center"
              >
                <i className="fas fa-expand text-xs"></i>
              </a>
              <button
                type="button"
                onClick={onClose}
                title="Close"
                aria-label="Close"
                className="w-8 h-8 rounded-lg bg-gray-900 border border-gray-700 text-gray-400 hover:text-white"
              >
                <i className="fas fa-times text-xs"></i>
              </button>
            </div>
          </div>
          {model && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-0.5">Model</div>
              <div className="font-mono text-gray-300 break-all">{String(model)}</div>
            </div>
          )}
          {prompt && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-0.5">Prompt</div>
              <div className="text-gray-300 whitespace-pre-wrap break-words">{String(prompt).slice(0, 2000)}</div>
            </div>
          )}
          {paramsStr && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-0.5">Params</div>
              <pre className="font-mono text-gray-400 bg-black/40 rounded-lg p-2 overflow-auto max-h-40 whitespace-pre-wrap break-all">{paramsStr}</pre>
            </div>
          )}
          {lorasStr && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-0.5">LoRAs</div>
              <pre className="font-mono text-gray-400 bg-black/40 rounded-lg p-2 overflow-auto max-h-32 whitespace-pre-wrap break-all">{lorasStr}</pre>
            </div>
          )}
          {rating != null && rating !== '' && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-0.5">Rating</div>
              <div className="text-amber-400">{'★'.repeat(Math.max(0, Math.min(5, Number(rating) || 0)))}<span className="text-gray-500 ml-1">{String(rating)}</span></div>
            </div>
          )}
          {cost && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-0.5">Cost</div>
              <div className="font-mono text-violet-300">{cost}</div>
            </div>
          )}
          {timestamp && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-0.5">Timestamp</div>
              <div className="text-gray-400">{String(timestamp).slice(0, 100)}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
