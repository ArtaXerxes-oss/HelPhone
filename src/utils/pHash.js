/**
 * Perceptual Image Hashing (pHash) for Duplicate Incident Detection
 *
 * Supports multiple algorithms:
 * - Difference Hash (dHash): Fast, rotation-sensitive
 * - Average Hash (aHash): Very fast, only detects significant changes
 * - DCT-based Hash: Better for compression/rotation tolerance
 *
 * Performance targets:
 * - Sub-100ms per image on mobile
 * - Hamming distance < 5 for duplicates
 */

const HASH_SIZE = 8;
const HASH_BITS = HASH_SIZE * HASH_SIZE;

/**
 * Compute Hamming distance between two hashes
 * @param {string} hash1 - First hash (hex string)
 * @param {string} hash2 - Second hash (hex string)
 * @returns {number} Hamming distance (0-64)
 */
export function hammingDistance(hash1, hash2) {
  if (hash1.length !== hash2.length) return HASH_BITS;

  let distance = 0;
  for (let i = 0; i < hash1.length; i++) {
    const xor = parseInt(hash1[i], 16) ^ parseInt(hash2[i], 16);
    distance += bin(xor).split('1').length - 1;
  }
  return distance;
}

/**
 * Difference Hash (dHash) - Fast and rotation-sensitive
 * Compares horizontal and vertical pixel differences
 * @param {HTMLImageElement|HTMLCanvasElement} image - Source image
 * @returns {string} 64-bit hash as hex string
 */
export function dhash(image) {
  const canvas = document.createElement('canvas');
  canvas.width = HASH_SIZE + 1;
  canvas.height = HASH_SIZE;

  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;

  let hash = '';

  for (let row = 0; row < HASH_SIZE; row++) {
    for (let col = 0; col < HASH_SIZE; col++) {
      const idx = (row * canvas.width + col) * 4;
      const left = data[idx]; // R channel
      const right = data[idx + 4]; // Next pixel R channel

      hash += left < right ? '1' : '0';
    }
  }

  // Convert binary to hex
  return binaryToHex(hash);
}

/**
 * Average Hash (aHash) - Very fast, only significant changes
 * @param {HTMLImageElement|HTMLCanvasElement} image - Source image
 * @returns {string} 64-bit hash as hex string
 */
export function ahash(image) {
  const canvas = document.createElement('canvas');
  canvas.width = HASH_SIZE;
  canvas.height = HASH_SIZE;

  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

  const imageData = ctx.getImageData(0, 0, HASH_SIZE, HASH_SIZE);
  const data = imageData.data;

  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    sum += data[i]; // R channel only
  }

  const average = sum / (HASH_SIZE * HASH_SIZE);

  let hash = '';
  for (let i = 0; i < data.length; i += 4) {
    hash += data[i] < average ? '0' : '1';
  }

  return binaryToHex(hash);
}

/**
 * DCT-based Hash - Better rotation/compression tolerance
 * Uses Discrete Cosine Transform for frequency-based hashing
 * @param {HTMLImageElement|HTMLCanvasElement} image - Source image
 * @returns {string} 64-bit hash as hex string
 */
export function dctHash(image) {
  const canvas = document.createElement('canvas');
  const size = 32; // Larger for better frequency analysis
  canvas.width = size;
  canvas.height = size;

  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0, size, size);

  const imageData = ctx.getImageData(0, 0, size, size);
  const pixels = imageData.data;

  // Extract grayscale values
  const grayscale = [];
  for (let i = 0; i < pixels.length; i += 4) {
    grayscale.push(pixels[i]); // R channel
  }

  // Simplified DCT (frequency-based features)
  // Real implementation would use full 2D DCT
  const dct = computeSimplifiedDCT(grayscale, size);

  // Use top-8x8 DCT coefficients for hash
  let hash = '';
  for (let i = 0; i < HASH_BITS && i < dct.length; i++) {
    hash += dct[i] > 0.5 ? '1' : '0';
  }

  return binaryToHex(hash);
}

/**
 * Simplified DCT computation (frequency features)
 * Full 2D DCT is expensive; this uses 1D DCT on pixel rows
 * @private
 */
function computeSimplifiedDCT(pixels, size) {
  const coeffs = [];

  for (let i = 0; i < Math.min(HASH_BITS, size * 2); i++) {
    let sum = 0;
    for (let j = 0; j < pixels.length; j++) {
      sum += pixels[j] * Math.cos((Math.PI * i * (j + 0.5)) / size);
    }
    coeffs.push(Math.abs(sum) / size);
  }

  // Normalize to 0-1 range
  const max = Math.max(...coeffs);
  return coeffs.map((c) => c / max);
}

/**
 * Analyze image distortion tolerance
 * Computes Hamming distance between original and distorted versions
 * @param {File} imageFile - Original image file
 * @param {Object} options - Distortion parameters
 * @returns {Promise<Object>} Distortion analysis results
 */
export async function analyzeDistortionTolerance(imageFile, options = {}) {
  const {
    algorithm = 'dhash', // 'dhash', 'ahash', or 'dctHash'
    compressionLevels = [10, 25, 50, 75, 90], // JPEG quality percentages
    rotationAngles = [5, 10, 15, 30], // Degrees
    resizeScales = [0.5, 0.75, 1.25, 1.5], // Scale factors
    brightnessLevels = [-30, -15, 15, 30], // Brightness shift in % 0-255 range
  } = options;

  const originalImage = await loadImage(imageFile);
  const hashFn = resolveHashFunction(algorithm);
  const originalHash = hashFn(originalImage);

  const results = {
    algorithm,
    originalHash,
    testResults: {
      compression: [],
      rotation: [],
      resize: [],
      brightness: [],
    },
    timestamp: new Date().toISOString(),
  };

  // Test compression tolerance
  for (const quality of compressionLevels) {
    const compressedBlob = await compressImage(imageFile, quality);
    const compressedImage = await loadImage(compressedBlob);
    const hash = hashFn(compressedImage);
    const distance = hammingDistance(originalHash, hash);

    results.testResults.compression.push({
      quality,
      hash,
      hammingDistance: distance,
      isDuplicate: distance < 5,
    });
  }

  // Test rotation tolerance
  for (const angle of rotationAngles) {
    const rotatedImage = rotateImage(originalImage, angle);
    const hash = hashFn(rotatedImage);
    const distance = hammingDistance(originalHash, hash);

    results.testResults.rotation.push({
      angle,
      hash,
      hammingDistance: distance,
      isDuplicate: distance < 5,
    });
  }

  // Test resize tolerance
  for (const scale of resizeScales) {
    const resizedImage = scaleImage(originalImage, scale);
    const hash = hashFn(resizedImage);
    const distance = hammingDistance(originalHash, hash);

    results.testResults.resize.push({
      scale,
      hash,
      hammingDistance: distance,
      isDuplicate: distance < 5,
    });
  }

  // Test brightness tolerance
  for (const delta of brightnessLevels) {
    const brightenedImage = adjustBrightness(originalImage, delta);
    const hash = hashFn(brightenedImage);
    const distance = hammingDistance(originalHash, hash);

    results.testResults.brightness.push({
      delta,
      hash,
      hammingDistance: distance,
      isDuplicate: distance < 5,
    });
  }

  return results;
}

/**
 * Load image from file/blob
 * @private
 */
function loadImage(fileOrBlob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(fileOrBlob);
  });
}

/**
 * Compress image to specified JPEG quality
 * @private
 */
async function compressImage(imageFile, quality) {
  const canvas = document.createElement('canvas');
  const image = await loadImage(imageFile);

  canvas.width = image.width;
  canvas.height = image.height;

  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);

  return new Promise((resolve) => {
    canvas.toBlob(resolve, 'image/jpeg', quality / 100);
  });
}

/**
 * Rotate image by angle (degrees)
 * @private
 */
function rotateImage(image, angle) {
  const canvas = document.createElement('canvas');
  const rad = (angle * Math.PI) / 180;

  canvas.width = image.width;
  canvas.height = image.height;

  const ctx = canvas.getContext('2d');
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(rad);
  ctx.drawImage(image, -image.width / 2, -image.height / 2);

  const rotated = new Image();
  rotated.src = canvas.toDataURL();
  return rotated;
}

/**
 * Scale image by factor
 * @private
 */
function scaleImage(image, scale) {
  const canvas = document.createElement('canvas');
  canvas.width = image.width * scale;
  canvas.height = image.height * scale;

  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

  const scaled = new Image();
  scaled.src = canvas.toDataURL();
  return scaled;
}

/**
 * Adjust image brightness
 * @private
 */
function adjustBrightness(image, delta) {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;

  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;

  for (let i = 0; i < data.length; i += 4) {
    data[i] = Math.max(0, Math.min(255, data[i] + delta));
    data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + delta));
    data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + delta));
  }

  ctx.putImageData(imageData, 0, 0);

  const adjusted = new Image();
  adjusted.src = canvas.toDataURL();
  return adjusted;
}

/**
 * Resolve hash function by name
 * @private
 */
function resolveHashFunction(algorithm) {
  switch (algorithm) {
    case 'ahash':
      return ahash;
    case 'dctHash':
      return dctHash;
    case 'dhash':
    default:
      return dhash;
  }
}

/**
 * Convert binary string to hex
 * @private
 */
function binaryToHex(binary) {
  let hex = '';
  for (let i = 0; i < binary.length; i += 4) {
    const chunk = binary.slice(i, i + 4);
    hex += parseInt(chunk, 2).toString(16);
  }
  return hex;
}

/**
 * Convert decimal to binary
 * @private
 */
function bin(num) {
  return num.toString(2);
}

export default {
  dhash,
  ahash,
  dctHash,
  hammingDistance,
  analyzeDistortionTolerance,
};
