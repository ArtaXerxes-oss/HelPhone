/**
 * Help.tsx — TypeScript entry that re-exports Help.jsx with ImageProcessor integration
 *
 * Canvas resizing & EXIF stripping is performed in the browser before any
 * submission via `src/lib/imageProcessor.ts`. See docs/privacy-policy.md.
 */
import Help from './Help.jsx';
import { processImage, hasExif, stripExifFromBuffer, MAX_DIMENSION, DEFAULT_QUALITY } from '../lib/imageProcessor.js';

// Re-export helpers for consumers that import from Help.tsx
export { processImage, hasExif, stripExifFromBuffer, MAX_DIMENSION, DEFAULT_QUALITY };

/**
 * Example integration (used by CreateRequestModal):
 *
 *   const result = await processImage(file, { maxDimension: 1200, quality: 0.8 });
 *   // result.blob is WebP/JPEG ≤1200px, EXIF stripped, ~85% smaller
 *   // send result.blob to storage / contract as needed
 */

export default Help;
