# Privacy Policy — HelPhone Image Handling

_Last updated: 2026-09-24_

## Summary

HelPhone is designed to protect you when you are most vulnerable. A photo you attach to a help request is **resized on your device before it ever leaves the browser** and all hidden metadata is stripped.

## What Happens to Your Photos

### 1. Client-Side Resizing (Canvas)

When you attach a photo in the Help flow (`src/lib/imageProcessor.ts` via `src/features/help/CreateRequestModal.tsx` and `src/pages/Help.jsx`):

- The image is drawn to an HTML5 Canvas / OffscreenCanvas at **max 1200px** on its long edge, preserving aspect ratio
- This happens entirely in your browser — the original file is never uploaded
- Example: a 4032×3024 phone photo (≈8MB) becomes 1200×900 (≈1MB)

### 2. EXIF Metadata Stripping

Phone photos contain hidden EXIF data:

- **GPS coordinates** (exact latitude/longitude where the photo was taken)
- **Camera serial number**, lens info
- **Timestamp** (when the photo was taken)

HelPhone **removes all of it**:

- `canvas.drawImage()` only copies pixels — APP1/EXIF segments are discarded by definition
- For JPEG output we additionally run `stripExifFromBuffer()` to delete any `Exif\0\0` APP1 segments that might survive re-encoding
- `hasExif()` is used to verify stripping before transmission

No GPS, serial, or timestamp leaves your device.

### 3. Compression (JPEG/WebP @ 80% Quality)

After resizing, the image is re-encoded:

- Preferred: `image/webp` at **80% quality**
- Fallback: `image/jpeg` at 80% quality (if WebP not supported)
- This achieves **~85% file size reduction** versus the original (e.g., 8MB → 1.2MB)

Quality was chosen to keep faces and scene details legible while dramatically reducing bandwidth and storage — important when responders are on slow mobile data.

## What Is Sent

Only the **processed blob** is sent:

- Dimensions ≤1200px
- No EXIF
- MIME type `image/webp` or `image/jpeg`
- 80% quality

The server and Soroban contract never see the original file, its GPS, or its camera identity.

## What Is Not Collected

- Original photo files are not stored
- EXIF GPS, camera make/serial, or capture time are not stored or logged
- No image-based tracking

## Technical Reference

- Processor: `src/lib/imageProcessor.ts` (`processImage()`, `stripExifFromBuffer()`, `calculateTargetSize()`)
- UI: `src/features/help/CreateRequestModal.tsx` and `src/pages/Help.tsx` (`Help.jsx`)
- Tests: `test/image-processor.test.js` (EXIF detection, stripping, 1200px cap, 80% quality, savings)
- Config: `vite.config.ts` / `vite.config.js` (canvas/WASM optimizations)

## Your Rights

You can:

- Attach a photo or not — it is always optional
- Inspect the code: the processor is local and open-source
- Request deletion: processed blobs follow the same retention rules as help requests (see `docs/database-architecture.md`)

Questions: see `README.md` or open an issue in the HelPhone repo.
