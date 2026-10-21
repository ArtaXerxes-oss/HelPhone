import { useState, useCallback } from 'react';
import { processImage, MAX_DIMENSION, DEFAULT_QUALITY } from '../../lib/imageProcessor';

interface Props {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: { blob: Blob | null; emergencyType: string }) => Promise<void>;
}

export default function CreateRequestModal({ open, onClose, onSubmit }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState('');
  const [savings, setSavings] = useState<number | null>(null);
  const [emergencyType, setEmergencyType] = useState('medical');

  const handleFile = useCallback(async (f: File | null) => {
    if (!f) { setFile(null); setPreview(null); setSavings(null); return; }
    if (!f.type.startsWith('image/')) { setError('Only image files are supported'); return; }
    setError('');
    setFile(f);
    // Preview original
    const url = URL.createObjectURL(f);
    setPreview(url);
    // Pre-process to show savings
    try {
      setProcessing(true);
      const result = await processImage(f, { maxDimension: MAX_DIMENSION, quality: DEFAULT_QUALITY });
      setSavings(result.savingsPct);
      // Replace preview with compressed preview (demonstrates EXIF stripping)
      URL.revokeObjectURL(url);
      setPreview(URL.createObjectURL(result.blob));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setProcessing(false);
    }
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!emergencyType) { setError('Select emergency type'); return; }
    setProcessing(true);
    setError('');
    try {
      let blob: Blob | null = null;
      if (file) {
        const result = await processImage(file, { maxDimension: MAX_DIMENSION, quality: DEFAULT_QUALITY });
        blob = result.blob;
        if (import.meta.env.DEV) {
          console.log(`[image] ${result.originalWidth}x${result.originalHeight} → ${result.width}x${result.height}, ${(result.savingsPct).toFixed(1)}% saved, EXIF stripped: ${result.exifStripped}`);
        }
      }
      await onSubmit({ blob, emergencyType });
      onClose();
    } catch (e) {
      setError((e as Error).message || 'Failed to process image');
    } finally {
      setProcessing(false);
    }
  }, [file, emergencyType, onSubmit, onClose]);

  if (!open) return null;

  return (
    <div role="dialog" aria-modal="true" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ width: '100%', maxWidth: 480, background: '#1c3535', borderRadius: 16, padding: 22, border: '1px solid rgba(63,132,135,0.3)' }}>
        <h3 style={{ margin: '0 0 14px', color: '#F4ECDC', fontFamily: "'Instrument Serif',serif", fontSize: 22 }}>Create Help Request</h3>

        <label style={{ display: 'block', marginBottom: 12 }}>
          <span style={{ fontSize: 12, color: 'rgba(242,236,220,0.6)' }}>Photo (optional — resized to {MAX_DIMENSION}px, EXIF stripped)</span>
          <input
            type="file"
            accept="image/*"
            onChange={e => handleFile(e.target.files?.[0] ?? null)}
            style={{ display: 'block', marginTop: 6, color: 'rgba(242,236,220,0.8)' }}
          />
        </label>

        {preview && (
          <div style={{ marginBottom: 12, borderRadius: 8, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.08)' }}>
            <img src={preview} alt="preview" style={{ width: '100%', maxHeight: 220, objectFit: 'cover' }} />
            {savings !== null && (
              <div style={{ padding: '6px 8px', fontSize: 11, color: '#7fb8ba', background: 'rgba(0,0,0,0.2)' }}>
                {savings.toFixed(1)}% size reduction · EXIF stripped · max {MAX_DIMENSION}px @ {Math.round(DEFAULT_QUALITY * 100)}% quality
              </div>
            )}
          </div>
        )}

        <label style={{ display: 'block', marginBottom: 14 }}>
          <span style={{ fontSize: 12, color: 'rgba(242,236,220,0.6)' }}>Emergency type</span>
          <select value={emergencyType} onChange={e => setEmergencyType(e.target.value)} style={{ width: '100%', marginTop: 6, padding: '8px 10px', borderRadius: 8, background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)', color: '#F4ECDC' }}>
            <option value="medical">Medical emergency</option>
            <option value="lost">I’m lost</option>
            <option value="fallen">Fell / injured</option>
            <option value="car">Car trouble</option>
            <option value="danger">I feel unsafe</option>
            <option value="other">Something else</option>
          </select>
        </label>

        {error && <div style={{ fontSize: 12, color: '#FF7A6B', marginBottom: 12 }}>{error}</div>}

        <div style={{ display: 'flex', gap: 10 }}>
          <button type="button" onClick={onClose} style={{ flex: 1, padding: '10px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.15)', background: 'transparent', color: 'rgba(242,236,220,0.7)', cursor: 'pointer' }}>Cancel</button>
          <button type="button" onClick={handleSubmit} disabled={processing} style={{ flex: 1, padding: '10px', borderRadius: 8, border: 'none', background: '#FF7A6B', color: '#fff', fontWeight: 700, cursor: processing ? 'default' : 'pointer', opacity: processing ? 0.7 : 1 }}>
            {processing ? 'Processing…' : 'Submit request'}
          </button>
        </div>
      </div>
    </div>
  );
}
