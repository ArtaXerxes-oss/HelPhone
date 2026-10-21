/**
 * Compression middleware — JS runtime (mirrors compression.ts)
 */
import * as zlib from 'zlib';

export const COMPRESSION_THRESHOLD = 1024;
export const BROTLI_QUALITY = 4;
export const GZIP_LEVEL = 6;

const BINARY_CONTENT_TYPE_RE = /^(image|video|audio|font)\//i;
const BINARY_EXT_RE = /\.(png|jpe?g|webp|gif|avif|ico|mp4|webm|mov|zip|gz|br|woff2?|ttf|eot|pdf|wasm)(\?|$)/i;
const ALREADY_COMPRESSED_ENCODING = new Set(['br', 'gzip', 'deflate', 'compress']);

export function isBinaryContentType(contentType) {
  if (!contentType) return false;
  const ct = contentType.split(';')[0].trim().toLowerCase();
  if (BINARY_CONTENT_TYPE_RE.test(ct)) return true;
  if (['application/zip', 'application/gzip', 'application/x-gzip', 'application/octet-stream', 'application/wasm'].includes(ct)) return true;
  return false;
}
export function isAlreadyCompressed(reqUrl, contentType, contentEncoding) {
  if (contentEncoding && ALREADY_COMPRESSED_ENCODING.has(contentEncoding.toLowerCase())) return true;
  if (isBinaryContentType(contentType)) return true;
  if (BINARY_EXT_RE.test(reqUrl)) return true;
  return false;
}
export function shouldCompress(req, res, threshold = COMPRESSION_THRESHOLD) {
  const accept = req.headers['accept-encoding'] || '';
  if (accept && accept !== '*' && !/(br|gzip|deflate)/i.test(String(accept))) return false;
  const existingEncoding = res.getHeader('content-encoding');
  if (existingEncoding && ALREADY_COMPRESSED_ENCODING.has(String(existingEncoding).toLowerCase())) return false;
  if (req.method === 'HEAD') return false;
  if (res.statusCode === 204 || res.statusCode === 304) return false;
  const contentType = res.getHeader('content-type') || '';
  const url = req.originalUrl || req.url || '';
  if (isAlreadyCompressed(url, contentType, existingEncoding)) return false;
  return true;
}
export function getPreferredEncoding(req) {
  const accept = String(req.headers['accept-encoding'] || '').toLowerCase();
  if (!accept) return null;
  const has = (enc) => {
    const re = new RegExp(`${enc}(?:\\s*;\\s*q\\s*=\\s*([0-9.]+))?`, 'i');
    const m = accept.match(re);
    if (!m) return false;
    if (m[1] && parseFloat(m[1]) === 0) return false;
    return true;
  };
  if (has('br')) return 'br';
  if (has('gzip')) return 'gzip';
  if (has('deflate')) return 'deflate';
  return null;
}
async function compressBuffer(buf, encoding, opts = {}) {
  const brotliQuality = opts.brotliQuality ?? BROTLI_QUALITY;
  const gzipLevel = opts.gzipLevel ?? GZIP_LEVEL;
  if (encoding === 'br') {
    return new Promise((resolve, reject) => {
      zlib.brotliCompress(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: brotliQuality, [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT } }, (err, r) => err ? reject(err) : resolve(r));
    });
  }
  if (encoding === 'gzip') {
    return new Promise((resolve, reject) => { zlib.gzip(buf, { level: gzipLevel }, (err, r) => err ? reject(err) : resolve(r)); });
  }
  return new Promise((resolve, reject) => { zlib.deflate(buf, (err, r) => err ? reject(err) : resolve(r)); });
}
export function compression(options = {}) {
  const threshold = options.threshold ?? COMPRESSION_THRESHOLD;
  return async (req, res, next) => {
    res.setHeader('Vary', 'Accept-Encoding');
    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);
    let chunks = [];
    let buffered = true;
    const shouldBuffer = () => {
      if (!shouldCompress(req, res, threshold)) return false;
      if (options.filter && !options.filter(req, res)) return false;
      return true;
    };
    res.write = function (chunk, ...args) {
      if (!shouldBuffer() || !buffered) return originalWrite(chunk, ...args);
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      return true;
    };
    res.end = function (chunk, ...args) {
      if (chunk) {
        const buf = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(String(chunk));
        if (shouldBuffer() && buffered) chunks.push(buf);
        else return originalEnd(chunk, ...args);
      }
      if (!shouldBuffer() || !buffered || chunks.length === 0) {
        buffered = false;
        if (chunks.length === 0) return originalEnd(...args);
        const body = Buffer.concat(chunks); chunks = [];
        if (body.length < threshold) { res.setHeader('Content-Length', String(body.length)); return originalEnd(body); }
        res.setHeader('Content-Length', String(body.length)); return originalEnd(body);
      }
      const body = Buffer.concat(chunks); chunks = []; buffered = false;
      if (body.length < threshold) { res.setHeader('Content-Length', String(body.length)); return originalEnd(body); }
      const encoding = getPreferredEncoding(req);
      if (!encoding) { res.setHeader('Content-Length', String(body.length)); return originalEnd(body); }
      compressBuffer(body, encoding, options).then(compressed => {
        if (compressed.length >= body.length * 0.95) { res.setHeader('Content-Length', String(body.length)); originalEnd(body); return; }
        res.setHeader('Content-Encoding', encoding);
        res.setHeader('Content-Length', String(compressed.length));
        if (options.debug) console.log(`[compression] ${req.method} ${req.originalUrl} ${body.length}→${compressed.length} (${((body.length - compressed.length)/body.length*100).toFixed(1)}% saved, ${encoding})`);
        originalEnd(compressed);
      }).catch(() => { res.setHeader('Content-Length', String(body.length)); originalEnd(body); });
      return res;
    };
    next();
  };
}
export function createCompression(opts) { return compression(opts); }
export async function measureCompressionSavings(payload, encoding = 'br', opts = {}) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const compressed = await compressBuffer(buf, encoding, opts);
  const savingsPct = ((buf.length - compressed.length) / buf.length) * 100;
  return { original: buf.length, compressed: compressed.length, savingsPct, ratio: compressed.length / buf.length };
}
export default compression;
