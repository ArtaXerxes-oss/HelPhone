import {
  trackLongTask,
  type LongTaskTelemetryEvent,
  type TelemetryPipeline,
} from './telemetry';

export const DEFAULT_LONG_TASK_THRESHOLDS: LongTaskThreshold = Object.freeze({
  warningMs: 50,
  criticalMs: 100,
});

export const MAX_BOUNDED_TASK_METRICS = 100;
export const MAX_BOUNDED_TELEMETRY_EVENTS = 50;

interface LongTaskThreshold {
  warningMs: number;
  criticalMs: number;
}

interface LongTaskMonitorOptions {
  maxTasks?: number;
  maxTelemetryEvents?: number;
  route?: string;
  pipeline?: TelemetryPipeline | null;
  onTelemetry?: (event: LongTaskTelemetryEvent) => void;
}

interface TaskMetrics {
  name: string;
  duration: number;
  startTime: number;
  endTime: number;
  severity: 'ok' | 'warning' | 'critical';
}

class SuperclusterOptimizer {
  private workerPool: Worker[] = [];
  private taskQueue: Array<{ data: unknown; resolve: Function; reject: Function }> = [];
  private activeWorkers = 0;
  private maxWorkers = 2;

  constructor(maxWorkers: number = 2) {
    this.maxWorkers = maxWorkers;
    this.initializeWorkerPool();
  }

  private initializeWorkerPool(): void {
    for (let i = 0; i < this.maxWorkers; i++) {
      const worker = new Worker(new URL('../workers/supercluster.worker.ts', import.meta.url), {
        type: 'module',
      });
      this.workerPool.push(worker);
    }
  }

  async clusterizeOffThread(
    points: Array<{ lat: number; lng: number; id: string }>,
    options: unknown,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.taskQueue.push({ data: { points, options }, resolve, reject });
      this.processQueue();
    });
  }

  private processQueue(): void {
    if (this.taskQueue.length === 0 || this.activeWorkers >= this.maxWorkers) {
      return;
    }

    const { data, resolve, reject } = this.taskQueue.shift()!;
    const worker = this.workerPool[this.activeWorkers];
    this.activeWorkers++;

    const timeoutId = setTimeout(() => {
      reject(new Error('Supercluster task timeout'));
      this.activeWorkers--;
      this.processQueue();
    }, 30000);

    worker.onmessage = (event) => {
      clearTimeout(timeoutId);
      resolve(event.data);
      this.activeWorkers--;
      this.processQueue();
    };

    worker.onerror = (error) => {
      clearTimeout(timeoutId);
      reject(error);
      this.activeWorkers--;
      this.processQueue();
    };

    worker.postMessage(data);
  }

  dispose(): void {
    for (const worker of this.workerPool) {
      worker.terminate();
    }
    this.workerPool = [];
    this.taskQueue = [];
  }
}

class FuseSearchOptimizer {
  private searchWorker: Worker | null = null;
  private isInitialized = false;

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    this.searchWorker = new Worker(new URL('../workers/fuse.worker.ts', import.meta.url), {
      type: 'module',
    });

    this.isInitialized = true;
  }

  async search(
    searchTerm: string,
    data: unknown[],
    options: unknown,
  ): Promise<Array<{ item: unknown; refIndex: number; score: number }>> {
    if (!this.searchWorker) {
      throw new Error('FuseSearchOptimizer not initialized');
    }

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error('Fuse search timeout'));
      }, 10000);

      const handler = (event: MessageEvent) => {
        clearTimeout(timeoutId);
        this.searchWorker!.removeEventListener('message', handler);
        resolve(event.data);
      };

      this.searchWorker.addEventListener('message', handler);
      this.searchWorker.postMessage({ searchTerm, data, options });
    });
  }

  dispose(): void {
    if (this.searchWorker) {
      this.searchWorker.terminate();
      this.searchWorker = null;
    }
    this.isInitialized = false;
  }
}

class GraphTraversalOptimizer {
  private chPreprocessCache: Map<string, unknown> = new Map();
  private preprocessingWorker: Worker | null = null;

  async initializePreprocessing(): Promise<void> {
    this.preprocessingWorker = new Worker(new URL('../workers/graphTraversal.worker.ts', import.meta.url), {
      type: 'module',
    });
  }

  async preprocessConvexHull(graphData: unknown): Promise<unknown> {
    if (!this.preprocessingWorker) {
      throw new Error('Preprocessing worker not initialized');
    }

    const cacheKey = this.generateCacheKey(graphData);
    if (this.chPreprocessCache.has(cacheKey)) {
      return this.chPreprocessCache.get(cacheKey);
    }

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error('Graph preprocessing timeout'));
      }, 15000);

      const handler = (event: MessageEvent) => {
        clearTimeout(timeoutId);
        this.preprocessingWorker!.removeEventListener('message', handler);

        this.chPreprocessCache.set(cacheKey, event.data);
        if (this.chPreprocessCache.size > 100) {
          const firstKey = this.chPreprocessCache.keys().next().value;
          this.chPreprocessCache.delete(firstKey);
        }

        resolve(event.data);
      };

      this.preprocessingWorker.addEventListener('message', handler);
      this.preprocessingWorker.postMessage({ graphData });
    });
  }

  private generateCacheKey(data: unknown): string {
    return JSON.stringify(data).substring(0, 256);
  }

  clearCache(): void {
    this.chPreprocessCache.clear();
  }

  dispose(): void {
    if (this.preprocessingWorker) {
      this.preprocessingWorker.terminate();
      this.preprocessingWorker = null;
    }
    this.clearCache();
  }
}

class LongTaskMonitor {
  private tasks: TaskMetrics[] = [];
  private telemetryEvents: LongTaskTelemetryEvent[] = [];
  private thresholds: LongTaskThreshold;
  private observer: PerformanceObserver | null = null;
  private callback: ((metrics: TaskMetrics[]) => void) | null = null;
  private readonly maxTasks: number;
  private readonly maxTelemetryEvents: number;
  private readonly route?: string;
  private readonly pipeline: TelemetryPipeline | null;
  private readonly onTelemetry?: (event: LongTaskTelemetryEvent) => void;

  constructor(
    thresholds: Partial<LongTaskThreshold> = DEFAULT_LONG_TASK_THRESHOLDS,
    options: LongTaskMonitorOptions = {},
  ) {
    this.thresholds = {
      warningMs: thresholds.warningMs ?? DEFAULT_LONG_TASK_THRESHOLDS.warningMs,
      criticalMs: thresholds.criticalMs ?? DEFAULT_LONG_TASK_THRESHOLDS.criticalMs,
    };
    this.maxTasks = Math.max(1, options.maxTasks ?? MAX_BOUNDED_TASK_METRICS);
    this.maxTelemetryEvents = Math.max(1, options.maxTelemetryEvents ?? MAX_BOUNDED_TELEMETRY_EVENTS);
    this.route = options.route;
    this.pipeline = options.pipeline ?? null;
    this.onTelemetry = options.onTelemetry;
  }

  setThresholds(next: Partial<LongTaskThreshold>): void {
    this.thresholds = {
      warningMs: next.warningMs ?? this.thresholds.warningMs,
      criticalMs: next.criticalMs ?? this.thresholds.criticalMs,
    };
  }

  getThresholds(): LongTaskThreshold {
    return { ...this.thresholds };
  }

  private pushBoundedTask(metric: TaskMetrics): void {
    this.tasks.push(metric);
    while (this.tasks.length > this.maxTasks) {
      this.tasks.shift();
    }
    if (metric.severity === 'critical') {
      const event = trackLongTask(
        {
          name: metric.name,
          durationMs: metric.duration,
          startTime: metric.startTime,
          endTime: metric.endTime,
          severity: 'critical',
          warningThresholdMs: this.thresholds.warningMs,
          criticalThresholdMs: this.thresholds.criticalMs,
          route: this.route,
        },
        this.pipeline,
      );
      this.telemetryEvents.push(event);
      while (this.telemetryEvents.length > this.maxTelemetryEvents) {
        this.telemetryEvents.shift();
      }
      this.onTelemetry?.(event);
    }
  }

  startMonitoring(callback?: (metrics: TaskMetrics[]) => void): void {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    this.callback = callback ?? null;

    if (typeof PerformanceObserver !== 'undefined') {
      try {
        this.observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.duration > this.thresholds.warningMs) {
              const boundedName = String(entry.name || 'longtask').slice(0, 64);
              const metric: TaskMetrics = {
                name: boundedName,
                duration: entry.duration,
                startTime: entry.startTime,
                endTime: entry.startTime + entry.duration,
                severity:
                  entry.duration > this.thresholds.criticalMs ? 'critical' : 'warning',
              };

              this.pushBoundedTask(metric);
              if (this.callback) {
                this.callback([metric]);
              }
            }
          }
        });

        this.observer.observe({ entryTypes: ['longtask', 'measure'] });
      } catch (e) {
        console.warn('LongTaskMonitor not supported:', e);
      }
    }
  }

  recordCustomTask(name: string, duration: number, startTime: number): void {
    const boundedName = String(name || 'longtask').slice(0, 64);
    const metric: TaskMetrics = {
      name: boundedName,
      duration,
      startTime,
      endTime: startTime + duration,
      severity: duration > this.thresholds.criticalMs ? 'critical' : duration > this.thresholds.warningMs ? 'warning' : 'ok',
    };

    this.pushBoundedTask(metric);
    if (this.callback) {
      this.callback([metric]);
    }
  }

  getMetrics(): TaskMetrics[] {
    return [...this.tasks];
  }

  getMetricsAboveThreshold(): TaskMetrics[] {
    return this.tasks.filter((t) => t.severity !== 'ok');
  }

  getTelemetryEvents(): LongTaskTelemetryEvent[] {
    return [...this.telemetryEvents];
  }

  generateReport(): {
    totalTasks: number;
    warningCount: number;
    criticalCount: number;
    averageDuration: number;
    maxDuration: number;
  } {
    const above = this.getMetricsAboveThreshold();
    const warnings = above.filter((t) => t.severity === 'warning').length;
    const critical = above.filter((t) => t.severity === 'critical').length;

    return {
      totalTasks: this.tasks.length,
      warningCount: warnings,
      criticalCount: critical,
      averageDuration: this.tasks.reduce((sum, t) => sum + t.duration, 0) / (this.tasks.length || 1),
      maxDuration: Math.max(...this.tasks.map((t) => t.duration), 0),
    };
  }

  stopMonitoring(): void {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    this.callback = null;
  }

  clear(): void {
    this.tasks = [];
    this.telemetryEvents = [];
  }
}

export {
  SuperclusterOptimizer,
  FuseSearchOptimizer,
  GraphTraversalOptimizer,
  LongTaskMonitor,
  LongTaskThreshold,
  LongTaskMonitorOptions,
  TaskMetrics,
};
