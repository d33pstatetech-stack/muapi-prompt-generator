import { useCallback, useEffect, useState } from 'react';
import { fetchHealth, fetchModel, fetchModels, syncCatalog } from './api';
import ModelPicker from './components/ModelPicker';
import ParamForm from './components/ParamForm';
import Section from './components/Section';

function useToast() {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((message, kind = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);
  return { toasts, push };
}

export default function App() {
  const { toasts, push: toast } = useToast();
  const [models, setModels] = useState([]);
  const [modelCount, setModelCount] = useState(null);
  const [syncedAt, setSyncedAt] = useState('');
  const [connected, setConnected] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [schema, setSchema] = useState(null);
  const [params, setParams] = useState({});
  const [loadingSchema, setLoadingSchema] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [ms, h] = await Promise.all([fetchModels(), fetchHealth().catch(() => null)]);
        setModels(ms);
        setModelCount(ms.length);
        setConnected(true);
        if (h?.synced_at) setSyncedAt(new Date(h.synced_at).toLocaleString());
      } catch (e) {
        setConnected(false);
        toast(`Failed to load catalog: ${e.message}`, 'error');
      }
    })();
  }, [toast]);

  const handleSelect = useCallback(async (id) => {
    setSelectedId(id);
    setSchema(null);
    setParams({});
    setLoadingSchema(true);
    try {
      const data = await fetchModel(id);
      const sch = data.schema || data.params || data;
      setSchema(sch);
      setParams({ ...(sch.defaults || {}) });
    } catch (e) {
      toast(`Failed to load model: ${e.message}`, 'error');
    } finally {
      setLoadingSchema(false);
    }
  }, [toast]);

  const handleSync = useCallback(async () => {
    setSyncing(true);
    try {
      await syncCatalog();
      const ms = await fetchModels();
      setModels(ms);
      setModelCount(ms.length);
      toast('Catalog synced', 'success');
    } catch (e) {
      toast(`Sync failed: ${e.message}`, 'error');
    } finally {
      setSyncing(false);
    }
  }, [toast]);

  const selected = models.find((m) => m.id === selectedId);

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <header className="border-b border-gray-800 sticky top-0 z-30 bg-gray-950/90 backdrop-blur">
        <div className="max-w-[1600px] mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center flex-none">
              <i className="fas fa-bolt text-white text-sm"></i>
            </div>
            <div className="min-w-0">
              <h1 className="text-base font-bold gradient-text truncate">MuAPI Prompt Generator</h1>
              <p className="text-[11px] text-gray-500 truncate">
                {modelCount ?? '—'} models · Image · Video · Audio · 3D{syncedAt ? ` · ${syncedAt}` : ''}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-none">
            <button onClick={handleSync} title="Update catalog" className="w-8 h-8 rounded-lg bg-gray-900 border border-gray-700 text-gray-400 hover:text-white" disabled={syncing}>
              <i className={`fas fa-sync-alt text-xs ${syncing ? 'fa-spin' : ''}`}></i>
            </button>
            <span title={connected ? 'Connected' : 'Disconnected'} className={`w-2 h-2 rounded-full ${connected ? 'bg-emerald-500' : 'bg-gray-600'}`}></span>
          </div>
        </div>
      </header>

      <main className="max-w-[1600px] mx-auto px-4 py-4 grid grid-cols-1 lg:grid-cols-[340px_1fr] xl:grid-cols-[340px_1fr_360px] gap-4">
        <div className="space-y-4">
          <Section icon="fa-brain" title="Model" step={1} summary={selectedId} defaultOpen={!selectedId}>
            <ModelPicker models={models} value={selectedId} onSelect={handleSelect} />
            {loadingSchema && <p className="text-xs text-gray-500 mt-2">Loading parameters…</p>}
          </Section>
          <Section icon="fa-sliders-h" title="Parameters" step={3} defaultOpen={!!selectedId} summary={selectedId && !schema ? 'loading…' : undefined}>
            {loadingSchema && <p className="text-xs text-gray-500">Loading parameters…</p>}
            {!loadingSchema && !schema && <p className="text-xs text-gray-600">Select a model to configure parameters.</p>}
            {!loadingSchema && schema && <ParamForm schema={schema} values={params} onChange={setParams} notify={toast} />}
          </Section>
        </div>

        <div className="space-y-4">
          <Section icon="fa-pen" title="Prompt" step={2} defaultOpen={true}>
            <p className="text-xs text-gray-600">Prompt box, generate button, cost estimate, status, and output land next.</p>
          </Section>
          <Section icon="fa-history" title="Recent" defaultOpen={false}>
            <p className="text-xs text-gray-600">No generations yet.</p>
          </Section>
        </div>

        <div className="space-y-4 hidden xl:block">
          <Section icon="fa-info-circle" title="Model Details" defaultOpen={true}>
            {selected ? (
              <div className="text-xs text-gray-400 space-y-1">
                <p className="font-mono text-gray-300 break-all">{selected.id}</p>
                <p>{selected.description || 'No description.'}</p>
              </div>
            ) : (
              <p className="text-xs text-gray-600">Select a model to see details.</p>
            )}
          </Section>
          <Section icon="fa-wand-magic-sparkles" title="AI Prompt Enhancer" defaultOpen={false}>
            <p className="text-xs text-gray-600">Streaming enhancer lands with the next pass.</p>
          </Section>
        </div>
      </main>

      <div className="fixed bottom-4 right-4 space-y-2 z-50 max-w-[90vw]">
        {toasts.map((t) => (
          <div key={t.id} className={`text-xs px-3 py-2 rounded-lg border shadow-xl ${t.kind === 'error' ? 'bg-red-950/90 border-red-800 text-red-200' : t.kind === 'success' ? 'bg-emerald-950/90 border-emerald-800 text-emerald-200' : 'bg-gray-900/95 border-gray-700 text-gray-200'}`}>
            {t.message}
          </div>
        ))}
      </div>
    </div>
  );
}
