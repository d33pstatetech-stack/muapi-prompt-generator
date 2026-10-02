import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchModelStats } from '../api';
import { filterModels } from '../lora-compat';

const GROUPS = [
  { id: 'image', icon: 'fa-image', label: 'Image' },
  { id: 'video', icon: 'fa-video', label: 'Video' },
  { id: 'audio', icon: 'fa-music', label: 'Audio' },
  { id: 'text', icon: 'fa-comment', label: 'Text' },
  { id: '3d', icon: 'fa-cube', label: '3D' },
  { id: 'all', icon: 'fa-th', label: 'All' },
];

const TIER_DOT = {
  verified: ['bg-emerald-500', 'Verified — this model completed a run with the pinned LoRA'],
  likely: ['bg-amber-400', 'Likely compatible with the pinned LoRA'],
  no: ['bg-red-500', 'Incompatible with the pinned LoRA (visible via Show all)'],
};

// AzNten house models: spec pattern /az.?nten|asian[-_ ]?ten/i plus
// underscore/dash/dot/space variants (az_nten, az-nten, asian_ten…).
function isAzNten(m) {
  const s = `${m?.id || ''} ${m?.name || ''}`;
  return /az.?nten|asian[-_ ]?ten/i.test(s) || /az[\s._-]*nten|asian[\s._-]*ten/i.test(s);
}

const FAVORITE_USAGE_TOP = 8;

// Searchable model picker with category tabs. Props: models, value (id),
// onSelect(id), focusLoras (pinned LoRA entries filter the list to
// compatibles), onClearFocus().
export default function ModelPicker({ models, value, onSelect, focusLoras, onClearFocus }) {
  const [group, setGroup] = useState('image');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [showAllModels, setShowAllModels] = useState(false);
  const [collapsed, setCollapsed] = useState({}); // cat -> true (collapsed by default)
  const [stats, setStats] = useState([]);
  const wrapRef = useRef(null);

  useEffect(() => {
    const close = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);

  useEffect(() => {
    let live = true;
    (async () => {
      const s = await fetchModelStats({ limit: 100 });
      if (live && Array.isArray(s)) setStats(s);
    })();
    return () => { live = false; };
  }, []);

  const focusing = Array.isArray(focusLoras) && focusLoras.length > 0;
  const mfilt = useMemo(() => filterModels(models, focusLoras), [models, focusLoras]);
  const tierOf = useMemo(() => {
    const m = new Map();
    for (const s of mfilt.shown) m.set(s.model.id, s.tier);
    for (const h of mfilt.hiddenItems) m.set(h.model.id, 'no');
    return m;
  }, [mfilt]);

  const runsOf = useMemo(() => {
    const m = new Map();
    for (const s of stats) {
      if (s && s.model) m.set(s.model, Number(s.runs) || 0);
    }
    return m;
  }, [stats]);
  const ratingOf = useMemo(() => {
    const m = new Map();
    for (const s of stats) {
      if (s && s.model && s.avg_rating != null) m.set(s.model, Number(s.avg_rating));
    }
    return m;
  }, [stats]);

  const filtered = useMemo(() => {
    const base = group === 'all' ? models : models.filter((m) => m.group_of === group);
    const q = query.trim().toLowerCase();
    const list = q ? base.filter((m) => (m.id || '').toLowerCase().includes(q) || (m.name || '').toLowerCase().includes(q)) : base;
    const compat = focusing && !showAllModels ? list.filter((m) => (tierOf.get(m.id) || 'likely') !== 'no') : list;
    const byCat = {};
    for (const m of compat) {
      const cat = m.category || 'Other';
      (byCat[cat] = byCat[cat] || []).push(m);
    }
    return Object.entries(byCat)
      .sort((a, b) => b[1].length - a[1].length)
      .map(([cat, ms]) => [cat, [...ms].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id))]);
  }, [models, group, query, focusing, showAllModels, tierOf]);

  // Favorites: (a) AzNten house models + (b) top-by-usage from
  // /api/history/model-stats. Same group/query/compat filters as the list,
  // sorted aznten-first then by runs desc.
  const favorites = useMemo(() => {
    const base = group === 'all' ? models : models.filter((m) => m.group_of === group);
    const q = query.trim().toLowerCase();
    const inScope = q
      ? base.filter((m) => (m.id || '').toLowerCase().includes(q) || (m.name || '').toLowerCase().includes(q))
      : base;
    const compat = focusing && !showAllModels
      ? inScope.filter((m) => (tierOf.get(m.id) || 'likely') !== 'no')
      : inScope;
    const scopeIds = new Set(compat.map((m) => m.id));
    const az = models.filter((m) => scopeIds.has(m.id) && isAzNten(m));
    const azIds = new Set(az.map((m) => m.id));
    const topUsage = [...stats]
      .sort((a, b) => (Number(b?.runs) || 0) - (Number(a?.runs) || 0))
      .slice(0, FAVORITE_USAGE_TOP)
      .map((s) => models.find((m) => m.id === s?.model))
      .filter((m) => m && scopeIds.has(m.id) && !azIds.has(m.id));
    const seen = new Set();
    const favs = [...az, ...topUsage].filter((m) => {
      if (!m || seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });
    return favs.sort((a, b) => {
      const aa = isAzNten(a) ? 0 : 1;
      const bb = isAzNten(b) ? 0 : 1;
      if (aa !== bb) return aa - bb;
      return (runsOf.get(b.id) || 0) - (runsOf.get(a.id) || 0);
    });
  }, [models, group, query, focusing, showAllModels, tierOf, stats, runsOf]);

  const count = useMemo(
    () => filtered.reduce((n, [, ms]) => n + ms.length, 0),
    [filtered]
  );

  const searching = query.trim() !== '';
  const toggleCat = (cat) => setCollapsed((c) => ({ ...c, [cat]: !c[cat] }));

  const selected = models.find((m) => m.id === value);

  const renderModelRow = (m) => (
    <button
      key={m.id}
      type="button"
      onClick={() => { onSelect(m.id); setOpen(false); setQuery(''); }}
      className={`w-full flex items-center gap-2 px-3 py-2 text-left text-xs hover:bg-gray-800 ${
        m.id === value ? 'text-violet-300 bg-violet-950/40' : 'text-gray-300'
      }`}
    >
      {focusing && (() => {
        const tier = tierOf.get(m.id) || 'likely';
        const [dotCls, dotTip] = TIER_DOT[tier] || TIER_DOT.likely;
        return <span title={dotTip} className={`w-2 h-2 rounded-full flex-none ${dotCls}`}></span>;
      })()}
      <span className="truncate flex-1">{m.id}</span>
      {(runsOf.get(m.id) || ratingOf.get(m.id) != null) && (
        <span className="flex-none text-[10px] font-mono text-gray-500" title={`${runsOf.get(m.id) || 0} runs${ratingOf.get(m.id) != null ? ` · ★${Number(ratingOf.get(m.id)).toFixed(1)}` : ''}`}>
          {runsOf.get(m.id) || 0}×{ratingOf.get(m.id) != null ? ` ★${Number(ratingOf.get(m.id)).toFixed(1)}` : ''}
        </span>
      )}
      <span className="flex-none text-[10px] font-mono text-gray-500">
        {m.cost > 0 ? `$${m.cost}` : 'Free'}{m.dynamic_pricing ? '*' : ''}
      </span>
    </button>
  );

  return (
    <div>
      {focusing && (
        <div className="mb-2 p-2 rounded-lg bg-fuchsia-950/40 border border-fuchsia-800">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] text-fuchsia-200 truncate" title={focusLoras.map((l) => l.name || l.id).join(', ')}>
              <i className="fas fa-thumbtack mr-1"></i>
              {mfilt.shown.length}/{models.length} models · {focusLoras.map((l) => l.name || l.id).join(' + ')}
            </span>
            {onClearFocus && (
              <button type="button" onClick={() => { onClearFocus(); setShowAllModels(false); }}
                className="text-[10px] text-fuchsia-300 hover:text-white underline flex-none">
                Clear
              </button>
            )}
          </div>
          <p className="mt-1 text-[9px] text-fuchsia-300/70">
            <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 mr-1 align-middle"></span>verified
            <span className="inline-block w-2 h-2 rounded-full bg-amber-400 ml-2 mr-1 align-middle"></span>likely
            {showAllModels && <><span className="inline-block w-2 h-2 rounded-full bg-red-500 ml-2 mr-1 align-middle"></span>incompatible</>}
          </p>
          {mfilt.hidden > 0 && (
            <label className="mt-1 flex items-center gap-1.5 text-[10px] text-fuchsia-200/80 cursor-pointer">
              <input type="checkbox" checked={showAllModels} onChange={(e) => setShowAllModels(e.target.checked)} className="accent-fuchsia-500" />
              {showAllModels ? 'Showing all — uncheck to re-apply filter' : `Show all ${models.length} (${mfilt.hidden} hidden by LoRA filter)`}
            </label>
          )}
        </div>
      )}
      <div className="flex gap-1.5 mb-2.5 overflow-x-auto pb-1 -mx-0.5 px-0.5">
        {GROUPS.map((g) => (
          <button
            key={g.id}
            type="button"
            onClick={() => { setGroup(g.id); setOpen(true); }}
            className={`flex-none text-xs px-3 py-1.5 rounded-full border transition-colors ${
              group === g.id
                ? 'bg-violet-600 border-violet-500 text-white'
                : 'bg-gray-900 border-gray-700 text-gray-400 hover:border-gray-500'
            }`}
          >
            <i className={`fas ${g.icon} mr-1.5`}></i>{g.label}
          </button>
        ))}
      </div>
      <div className="relative" ref={wrapRef}>
        <div className="flex items-center gap-2 bg-gray-900 border border-gray-700 rounded-lg px-3">
          <i className="fas fa-search text-gray-600 text-xs"></i>
          <input
            value={query}
            onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
            onFocus={() => setOpen(true)}
            type="text"
            placeholder={value || 'Search models...'}
            aria-label="Search models"
            className="flex-1 bg-transparent py-2.5 text-sm outline-none placeholder:text-gray-600"
          />
          <span className="text-[11px] text-gray-500 flex-none">{count}</span>
        </div>
        {open && (
          <div className="absolute z-40 left-0 right-0 mt-1 max-h-72 overflow-y-auto bg-gray-900 border border-gray-700 rounded-lg shadow-xl">
            {filtered.length === 0 && favorites.length === 0 && <div className="p-4 text-sm text-gray-600">No models found</div>}
            {favorites.length > 0 && (
              <div>
                <div className="px-3 pt-2.5 pb-1 text-[10px] uppercase tracking-wider text-amber-300 sticky top-0 bg-gray-900">
                  ★ Favorites ({favorites.length})
                </div>
                {favorites.map(renderModelRow)}
              </div>
            )}
            {filtered.map(([cat, ms]) => {
              const isCollapsed = searching ? false : !!collapsed[cat];
              return (
                <div key={cat}>
                  <button
                    type="button"
                    onClick={() => toggleCat(cat)}
                    aria-expanded={!isCollapsed}
                    className="w-full flex items-center gap-1.5 px-3 pt-2.5 pb-1 text-[10px] uppercase tracking-wider text-gray-500 sticky top-0 bg-gray-900 hover:text-gray-300 text-left"
                  >
                    <i className={`fas ${isCollapsed ? 'fa-chevron-right' : 'fa-chevron-down'} text-[8px]`}></i>
                    <span className="flex-1 truncate">{cat} ({ms.length})</span>
                  </button>
                  {!isCollapsed && ms.map(renderModelRow)}
                </div>
              );
            })}
          </div>
        )}
      </div>
      {selected && (
        <div className="flex items-center gap-2 mt-2 text-xs">
          <span className="text-[10px] uppercase tracking-wide bg-gray-800 text-gray-300 px-2 py-0.5 rounded-full">
            {selected.category}
          </span>
          {selected.cost > 0 && <span className="text-gray-400 font-mono">${selected.cost}{selected.dynamic_pricing ? '*' : ''}</span>}
          {selected.playground_url && (
            <a href={selected.playground_url} target="_blank" rel="noreferrer" className="text-violet-400 hover:text-violet-300 ml-auto">
              <i className="fas fa-external-link-alt"></i> Playground
            </a>
          )}
        </div>
      )}
    </div>
  );
}
