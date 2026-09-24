/**
 * Image Processor — JS runtime (mirrors imageProcessor.ts)
 */
export const MAX_DIMENSION = 1200;
export const DEFAULT_QUALITY = 0.8;
export const OUTPUT_TYPE = 'image/webp';
export const FALLBACK_TYPE = 'image/jpeg';

export function hasExif(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length < 4) return false;
  for (let i = 0; i < bytes.length - 10; i++) {
    if (bytes[i] === 0xFF && bytes[i + 1] === 0xE1) {
      if (bytes[i + 4] === 0x45 && bytes[i + 5] === 0x78 && bytes[i + 6] === 0x69 && bytes[i + 7] === 0x66 && bytes[i + 8] === 0x00 && bytes[i + 9] === 0x00) return true;
    }
  }
  return false;
}
export function stripExifFromBuffer(input) {
  if (!hasExif(input)) return input;
  const out = []; let i = 0;
  if (input.length >= 2 && input[0] === 0xFF && input[1] === 0xD8) { out.push(0xFF, 0xD8); i = 2; }
  while (i < input.length - 1) {
    if (input[i] !== 0xFF) { out.push(input[i]); i++; continue; }
    const marker = input[i + 1];
    if (marker === 0xD8 || marker === 0xD9 || (marker >= 0xD0 && marker <= 0xD7) || marker === 0x01) { out.push(0xFF, marker); i += 2; continue; }
    if (i + 3 >= input.length) { out.push(input[i]); i++; continue; }
    const len = (input[i + 2] << 8) | input[i + 3];
    if (len < 2 || i + len + 1 >= input.length + 100000) { out.push(input[i]); i++; continue; }
    if (marker === 0xE1) {
      const isExif = i + 9 < input.length && input[i + 4] === 0x45 && input[i + 5] === 0x78 && input[i + 6] === 0x69 && input[i + 7] === 0x66 && input[i + 8] === 0x00 && input[i + 9] === 0x00;
      if (isExif) { i += 2 + len; continue; }
    }
    for (let j = 0; j < 2 + len && i + j < input.length; j++) out.push(input[i + j]);
    i += 2 + len;
  }
  return new Uint8Array(out);
}
export function calculateTargetSize(width, height, maxDimension = MAX_DIMENSION) {
  if (width <= maxDimension && height <= maxDimension) return { width, height, scaled: false };
  const ratio = Math.min(maxDimension / width, maxDimension / height);
  return { width: Math.round(width * ratio), height: Math.round(height * ratio), scaled: true };
}
async function loadImage(blob) {
  if (typeof createImageBitmap !== 'undefined') {
    try { const bitmap = await createImageBitmap(blob); return { img: bitmap, w: bitmap.width, h: bitmap.height, close: () => bitmap.close() }; } catch {}
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve({ img, w: img.naturalWidth || img.width, h: img.naturalHeight || img.height }); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Failed to load image')); };
    img.src = url; img.crossOrigin = 'anonymous';
  });
}
function getCanvas(width, height) {
  let canvas; let ctx = null;
  if (typeof OffscreenCanvas !== 'undefined') {
    try { canvas = new OffscreenCanvas(width, height); ctx = canvas.getContext('2d'); if (ctx) return { canvas, ctx }; } catch {}
  }
  if (typeof document !== 'undefined') {
    canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; ctx = canvas.getContext('2d'); if (ctx) return { canvas, ctx };
  }
  return null;
}
async function canvasToBlob(canvas, type, quality) {
  if (typeof canvas.convertToBlob === 'function') return await canvas.convertToBlob({ type, quality });
  const htmlCanvas = canvas;
  return await new Promise((resolve, reject) => { htmlCanvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Canvas toBlob failed')), type, quality); });
}
export async function processImage(file, opts = {}) {
  const maxDimension = opts.maxDimension ?? MAX_DIMENSION;
  const quality = opts.quality ?? DEFAULT_QUALITY;
  let outputType = opts.outputType ?? OUTPUT_TYPE;
  const originalSize = file.size;
  if (originalSize === 0) throw new Error('Empty file');
  let hadExif = false;
  try { const head = new Uint8Array(await file.slice(0, 128 * 1024).arrayBuffer()); hadExif = hasExif(head); } catch {}
  const { img, w: origW, h: origH, close } = await loadImage(file);
  try {
    const target = calculateTargetSize(origW, origH, maxDimension);
    const canvasInfo = getCanvas(target.width, target.height);
    if (!canvasInfo) throw new Error('Canvas not available in this environment');
    const { canvas, ctx } = canvasInfo;
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    if (outputType === 'image/jpeg' || outputType === FALLBACK_TYPE) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, target.width, target.height); } else ctx.clearRect(0, 0, target.width, target.height);
    ctx.drawImage(img, 0, 0, target.width, target.height);
    let blob;
    try { blob = await canvasToBlob(canvas, outputType, quality); if (outputType === 'image/webp' && blob.type !== 'image/webp') throw new Error('WebP not supported'); } catch { outputType = FALLBACK_TYPE; blob = await canvasToBlob(canvas, outputType, quality); }
    let finalBlob = blob;
    if (outputType === 'image/jpeg') {
      const buf = new Uint8Array(await blob.arrayBuffer());
      if (hasExif(buf)) { const stripped = stripExifFromBuffer(buf); finalBlob = new Blob([stripped], { type: outputType }); }
    }
    const compressedSize = finalBlob.size;
    const savingsPct = originalSize > 0 ? ((originalSize - compressedSize) / originalSize) * 100 : 0;
    return { blob: finalBlob, originalSize, compressedSize, savingsPct, width: target.width, height: target.height, originalWidth: origW, originalHeight: origH, exifStripped: hadExif, outputType, quality };
  } finally { close?.(); }
}
export async function processImageToUrl(file, opts) { const result = await processImage(file, opts); const url = URL.createObjectURL(result.blob); return { url, result }; }
export async function isWebPSupported() {
  if (typeof document === 'undefined') return false;
  return new Promise((resolve) => { const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1; canvas.toBlob((blob) => resolve(!!blob && blob.type === 'image/webp'), 'image/webp', 0.8); });
}
export default { processImage, processImageToUrl, hasExif, stripExifFromBuffer, calculateTargetSize, isWebPSupported, MAX_DIMENSION, DEFAULT_QUALITY };
