interface FontSubsetConfig {
  fontFamily: string;
  weights: number[];
  styles: ('normal' | 'italic')[];
  formats: ('woff2' | 'woff' | 'ttf')[];
  unicodeRanges: UnicodeRange[];
  preloadCriticalSubsets: boolean;
}

interface UnicodeRange {
  name: string;
  range: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  languages: string[];
}

interface FontLoadStrategy {
  critical: string[];
  preload: string[];
  prefetch: string[];
}

class FontSubsettingManager {
  private config: FontSubsetConfig;
  private loadedSubsets: Set<string> = new Set();
  private loadingPromises: Map<string, Promise<void>> = new Map();

  constructor(config: FontSubsetConfig) {
    this.config = config;
  }

  getUnicodeRangesForLanguage(language: string): UnicodeRange[] {
    return this.config.unicodeRanges.filter(
      (range) => range.languages.includes(language) || range.languages.includes('*'),
    );
  }

  getCriticalSubsets(): string[] {
    return this.config.unicodeRanges
      .filter((range) => range.priority === 'critical')
      .map((range) => range.name);
  }

  getLoadStrategy(): FontLoadStrategy {
    const critical = this.config.unicodeRanges
      .filter((r) => r.priority === 'critical')
      .map((r) => r.name);

    const highPriority = this.config.unicodeRanges
      .filter((r) => r.priority === 'high')
      .map((r) => r.name);

    const medium = this.config.unicodeRanges
      .filter((r) => r.priority === 'medium')
      .map((r) => r.name);

    return {
      critical,
      preload: highPriority,
      prefetch: medium,
    };
  }

  async loadSubset(name: string): Promise<void> {
    if (this.loadedSubsets.has(name)) return;

    const existing = this.loadingPromises.get(name);
    if (existing) return existing;

    const promise = this.performLoad(name);
    this.loadingPromises.set(name, promise);

    try {
      await promise;
      this.loadedSubsets.add(name);
    } catch (e) {
      console.error(`Failed to load font subset: ${name}`, e);
      throw e;
    } finally {
      this.loadingPromises.delete(name);
    }
  }

  private async performLoad(name: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = this.getSubsetUrl(name);

      link.onload = () => resolve();
      link.onerror = () => reject(new Error(`Failed to load font: ${name}`));

      document.head.appendChild(link);
    });
  }

  private getSubsetUrl(name: string): string {
    const format = this.getOptimalFormat();
    return `/fonts/subsets/${name}.${format}.css`;
  }

  private getOptimalFormat(): string {
    const isSafari = /Safari/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent);

    if (isSafari) {
      return 'ttf';
    }

    const isModern = CSS.supports('font-format', 'woff2');
    return isModern ? 'woff2' : 'woff';
  }

  async preloadCritical(): Promise<void> {
    const criticalSubsets = this.getCriticalSubsets();
    await Promise.all(criticalSubsets.map((name) => this.loadSubset(name)));
  }

  isSubsetLoaded(name: string): boolean {
    return this.loadedSubsets.has(name);
  }

  getLoadedSubsets(): string[] {
    return Array.from(this.loadedSubsets);
  }
}

class AssetSubsettingManager {
  private imageOptimizations: Map<string, ImageOptimizationConfig> = new Map();
  private videoOptimizations: Map<string, VideoOptimizationConfig> = new Map();

  registerImage(name: string, config: ImageOptimizationConfig): void {
    this.imageOptimizations.set(name, config);
  }

  registerVideo(name: string, config: VideoOptimizationConfig): void {
    this.videoOptimizations.set(name, config);
  }

  getResponsiveImageSrcSet(name: string): string {
    const config = this.imageOptimizations.get(name);
    if (!config) return '';

    return config.formats
      .map((fmt) => `${this.getImagePath(name, fmt.width)}${fmt.width}w`)
      .join(', ');
  }

  getOptimalVideoSource(name: string, screenWidth: number): VideoSource {
    const config = this.videoOptimizations.get(name);
    if (!config) return { src: '', type: 'video/mp4' };

    const optimalFormat = config.formats.find((fmt) => fmt.maxWidth >= screenWidth) || config.formats[0];

    return {
      src: this.getVideoPath(name, optimalFormat.resolution),
      type: optimalFormat.codec,
      size: optimalFormat.estimatedSize,
    };
  }

  private getImagePath(name: string, width: number): string {
    return `/images/optimized/${name}-${width}w.webp `;
  }

  private getVideoPath(name: string, resolution: string): string {
    return `/videos/optimized/${name}-${resolution}.mp4`;
  }

  calculateBundleSize(includeFormats: string[]): number {
    let total = 0;

    for (const [_, config] of this.imageOptimizations) {
      total += config.formats
        .filter((f) => includeFormats.includes(f.format))
        .reduce((sum, f) => sum + (f.estimatedSize || 0), 0);
    }

    for (const [_, config] of this.videoOptimizations) {
      total += config.formats
        .filter((f) => includeFormats.includes(f.codec))
        .reduce((sum, f) => sum + (f.estimatedSize || 0), 0);
    }

    return total;
  }
}

interface ImageOptimizationConfig {
  original: string;
  formats: Array<{
    format: string;
    width: number;
    estimatedSize?: number;
  }>;
}

interface VideoOptimizationConfig {
  original: string;
  formats: Array<{
    codec: string;
    resolution: string;
    maxWidth: number;
    estimatedSize?: number;
  }>;
}

interface VideoSource {
  src: string;
  type: string;
  size?: number;
}

class PWAPrecacheOptimizer {
  private precacheManifest: PrecacheEntry[] = [];
  private maxPrecacheSize = 5 * 1024 * 1024;

  addEntry(path: string, size: number, priority: 'critical' | 'high' | 'medium' | 'low'): void {
    this.precacheManifest.push({
      path,
      size,
      priority,
      revision: `v${Date.now()}`,
    });
  }

  optimizePrecache(): PrecacheEntry[] {
    const sorted = [...this.precacheManifest].sort((a, b) => {
      const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    });

    let totalSize = 0;
    const optimized: PrecacheEntry[] = [];

    for (const entry of sorted) {
      if (totalSize + entry.size <= this.maxPrecacheSize) {
        optimized.push(entry);
        totalSize += entry.size;
      } else if (entry.priority === 'critical') {
        optimized.push(entry);
        totalSize += entry.size;
      }
    }

    return optimized;
  }

  generateManifestJSON(): string {
    const optimized = this.optimizePrecache();
    return JSON.stringify(optimized, null, 2);
  }

  getEstimatedSize(): number {
    return this.optimizePrecache().reduce((sum, entry) => sum + entry.size, 0);
  }

  getSizeExceeded(): boolean {
    return this.getEstimatedSize() > this.maxPrecacheSize;
  }
}

interface PrecacheEntry {
  path: string;
  size: number;
  priority: 'critical' | 'high' | 'medium' | 'low';
  revision: string;
}

export {
  FontSubsettingManager,
  AssetSubsettingManager,
  PWAPrecacheOptimizer,
  FontSubsetConfig,
  ImageOptimizationConfig,
  VideoOptimizationConfig,
  PrecacheEntry,
};
