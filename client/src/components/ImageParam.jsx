import { useRef, useState } from 'react';
import { uploadFileBlob } from '../api';
import CloudPicker from './CloudPicker';

// Image / image-array param: upload + R2 file + URL paste.
// Props: name, multi, value (string|string[]), onChange, notify(msg, kind).
export default function ImageParam({ name, multi, value, onChange, notify }) {
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState('');
  const [drag, setDrag] = useState(false);
  const [r2open, setR2open] = useState(false);
  const fileRef = useRef(null);

  const list = multi ? (Array.isArray(value) ? value : value ? [value] : []) : value ? [value] : [];

  const put = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      const data = await uploadFileBlob(file);
      const out = data.url || data.fileUrl || data.path;
      if (!out) throw new Error('Upload returned no URL');
      onChange(multi ? [...list, out].slice(0, 9) : out);
    } catch (e) {
      notify && notify(`Upload failed: ${e.message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const addUrl = () => {
    const u = url.trim();
    if (!u) return;
    onChange(multi ? [...list, u].slice(0, 9) : u);
    setUrl('');
  };

  const removeAt = (i) => {
    if (multi) {
      const next = list.filter((_, j) => j !== i);
      onChange(next.length ? next : undefined);
    } else {
      onChange(undefined);
    }
  };

  return (
    <div className="space-y-2">
      {list.length > 0 && (
        <div className={`grid gap-2 ${multi ? 'grid-cols-3' : 'grid-cols-1'}`}>
          {list.map((u, i) => (
            <div key={i} className="relative rounded-lg overflow-hidden border border-gray-700 bg-gray-900">
              <img src={u} alt="" className={`w-full object-cover ${multi ? 'h-16' : 'max-h-48'}`} />
              <button
                type="button"
                onClick={() => removeAt(i)}
                aria-label="Remove image"
                className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/70 text-gray-300 text-xs"
              >
                <i className="fas fa-times"></i>
              </button>
            </div>
          ))}
        </div>
      )}
      <div
        onClick={() => fileRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); put(e.dataTransfer.files?.[0]); }}
        className={`rounded-lg border border-dashed px-3 py-4 text-center cursor-pointer transition-colors ${
          drag ? 'border-violet-400 bg-violet-950/30' : 'border-gray-700 hover:border-gray-500'
        }`}
      >
        <i className={`fas ${multi ? 'fa-images' : 'fa-cloud-upload-alt'} text-gray-600 text-xl`}></i>
        <p className="text-xs text-gray-400 mt-1">{busy ? 'Uploading…' : multi ? 'Add images (up to 9)' : 'Tap or drop an image to upload'}</p>
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => put(e.target.files?.[0])} />
      </div>
      <div className="flex gap-1.5">
        <button type="button" onClick={() => setR2open(true)} title="Pick a file from R2 storage" className="btn-secondary flex-none !text-xs">
          <i className="fas fa-cloud mr-1"></i>R2
        </button>
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') addUrl(); }}
          placeholder="Or paste image URL…"
          aria-label="Image URL"
          className="input !text-xs"
        />
        <button type="button" onClick={addUrl} className="btn-primary-sm flex-none">{multi ? 'Add' : 'Use URL'}</button>
      </div>
      <CloudPicker open={r2open} onClose={() => setR2open(false)} notify={notify}
        onPick={(resolved) => onChange(multi ? [...list, resolved].slice(0, 9) : resolved)} />
    </div>
  );
}
