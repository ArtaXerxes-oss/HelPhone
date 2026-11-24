import mapboxgl from 'mapbox-gl';

interface ResourceHandle {
  dispose(): void;
  isDisposed(): boolean;
}

type OverlayDisposable = { destroy?: () => void; dispose?: () => void } | (() => void);
type MarkerDisposable = { remove?: () => void };

class MapboxGLResourceManager implements ResourceHandle {
  private map: mapboxgl.Map | null = null;
  private disposed = false;
  private eventListeners: Array<{ type: string; handler: Function; target?: any }> = [];
  private animationFrameId: number | null = null;
  private animationFrameIds: Set<number> = new Set();
  private overlays: Set<OverlayDisposable> = new Set();
  private markers: Set<MarkerDisposable> = new Set();

  setMap(map: mapboxgl.Map | null): void {
    if (this.map && this.map !== map && !this.map.isRemoved?.()) {
      try {
        this.map.remove();
      } catch (e) {
        console.warn('Error removing previous Mapbox GL map:', e);
      }
    }
    this.map = map;
    if (map) {
      this.disposed = false;
    }
  }

  getMap(): mapboxgl.Map | null {
    return this.map;
  }

  registerEventListener(type: string, handler: Function, target?: any): void {
    this.disposed = false;
    this.eventListeners.push({ type, handler, target });
  }

  setAnimationFrame(id: number | null): void {
    this.animationFrameId = id;
    if (id !== null) {
      this.disposed = false;
      this.animationFrameIds.add(id);
    }
  }

  registerOverlay(overlay: OverlayDisposable): void {
    if (!overlay) return;
    this.disposed = false;
    this.overlays.add(overlay);
  }

  unregisterOverlay(overlay: OverlayDisposable): void {
    this.overlays.delete(overlay);
  }

  registerMarker(marker: MarkerDisposable): void {
    if (!marker) return;
    this.disposed = false;
    this.markers.add(marker);
  }

  getActiveResourceCount(): {
    listeners: number;
    overlays: number;
    markers: number;
    animationFrames: number;
    hasMap: boolean;
  } {
    return {
      listeners: this.eventListeners.length,
      overlays: this.overlays.size,
      markers: this.markers.size,
      animationFrames: this.animationFrameIds.size + (this.animationFrameId !== null && !this.animationFrameIds.has(this.animationFrameId) ? 1 : 0),
      hasMap: this.map !== null,
    };
  }

  dispose(): void {
    if (this.disposed) return;

    for (const { type, handler, target } of this.eventListeners) {
      const listenerTarget = target ?? this.map;
      if (listenerTarget) {
        try {
          if (typeof listenerTarget.off === 'function') {
            listenerTarget.off(type as any, handler as any);
          } else if (typeof listenerTarget.removeEventListener === 'function') {
            listenerTarget.removeEventListener(type, handler as any);
          }
        } catch (e) {
          console.warn('Error removing event listener:', e);
        }
      }
    }
    this.eventListeners = [];

    if (this.animationFrameId !== null) {
      if (typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(this.animationFrameId);
      }
      this.animationFrameId = null;
    }
    for (const id of this.animationFrameIds) {
      if (typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(id);
      }
    }
    this.animationFrameIds.clear();

    for (const overlay of this.overlays) {
      try {
        if (typeof overlay === 'function') {
          overlay();
        } else {
          overlay.destroy?.();
          overlay.dispose?.();
        }
      } catch (e) {
        console.warn('Error disposing map overlay:', e);
      }
    }
    this.overlays.clear();

    for (const marker of this.markers) {
      try {
        marker.remove?.();
      } catch (e) {
        console.warn('Error removing map marker:', e);
      }
    }
    this.markers.clear();

    if (this.map && !this.map.isRemoved?.()) {
      try {
        this.map.remove();
      } catch (e) {
        console.warn('Error removing Mapbox GL map:', e);
      }
    }

    this.map = null;
    this.disposed = true;
  }

  isDisposed(): boolean {
    return this.disposed;
  }
}

class YjsResourceManager implements ResourceHandle {
  private undoManagers: Array<any> = [];
  private observers: Array<{ binding: any; observer: any }> = [];
  private disposed = false;

  registerUndoManager(undoManager: any): void {
    this.undoManagers.push(undoManager);
  }

  registerObserver(binding: any, observer: any): void {
    this.observers.push({ binding, observer });
  }

  dispose(): void {
    if (this.disposed) return;

    for (const undoManager of this.undoManagers) {
      try {
        undoManager.destroy?.();
      } catch (e) {
        console.warn('Error destroying Yjs UndoManager:', e);
      }
    }
    this.undoManagers = [];

    for (const { binding, observer } of this.observers) {
      try {
        binding.unobserve?.(observer);
      } catch (e) {
        console.warn('Error unobserving Yjs binding:', e);
      }
    }
    this.observers = [];

    this.disposed = true;
  }

  isDisposed(): boolean {
    return this.disposed;
  }
}

class WebSocketResourceManager implements ResourceHandle {
  private sockets: Map<string, WebSocket> = new Map();
  private listeners: Map<string, Array<{ event: string; handler: Function }>> = new Map();
  private reconnectTimeouts: Map<string, NodeJS.Timeout> = new Map();
  private disposed = false;
  private maxReconnectAttempts = 5;
  private reconnectAttempts: Map<string, number> = new Map();

  addSocket(id: string, socket: WebSocket): void {
    if (this.disposed) {
      socket.close();
      return;
    }

    const existing = this.sockets.get(id);
    if (existing && existing.readyState !== WebSocket.CLOSED) {
      existing.close();
    }

    this.sockets.set(id, socket);
    this.listeners.set(id, []);
    this.reconnectAttempts.set(id, 0);

    socket.addEventListener('close', () => {
      this.handleSocketClose(id);
    });
  }

  addEventListener(id: string, event: string, handler: Function): void {
    const socket = this.sockets.get(id);
    if (!socket) return;

    const listeners = this.listeners.get(id) || [];
    listeners.push({ event, handler });
    this.listeners.set(id, listeners);

    socket.addEventListener(event, handler as EventListener);
  }

  private handleSocketClose(id: string): void {
    const attempts = this.reconnectAttempts.get(id) || 0;

    if (attempts < this.maxReconnectAttempts) {
      const backoffMs = Math.min(1000 * Math.pow(2, attempts), 30000);
      const timeoutId = setTimeout(() => {
        this.reconnectAttempts.set(id, attempts + 1);
        this.reconnectTimeouts.delete(id);
      }, backoffMs);

      this.reconnectTimeouts.set(id, timeoutId);
    }
  }

  dispose(): void {
    if (this.disposed) return;

    for (const [id, socket] of this.sockets) {
      const listeners = this.listeners.get(id) || [];
      for (const { event, handler } of listeners) {
        socket.removeEventListener(event, handler as EventListener);
      }

      if (socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) {
        socket.close();
      }
    }

    for (const timeoutId of this.reconnectTimeouts.values()) {
      clearTimeout(timeoutId);
    }

    this.sockets.clear();
    this.listeners.clear();
    this.reconnectTimeouts.clear();
    this.reconnectAttempts.clear();
    this.disposed = true;
  }

  isDisposed(): boolean {
    return this.disposed;
  }
}

class CrossRouteResourceManager {
  private mapboxManager: MapboxGLResourceManager;
  private yjsManager: YjsResourceManager;
  private wsManager: WebSocketResourceManager;
  private navigationCount = 0;
  private maxNavigationsBeforeWarning = 20;

  constructor() {
    this.mapboxManager = new MapboxGLResourceManager();
    this.yjsManager = new YjsResourceManager();
    this.wsManager = new WebSocketResourceManager();
  }

  getMapboxManager(): MapboxGLResourceManager {
    return this.mapboxManager;
  }

  getYjsManager(): YjsResourceManager {
    return this.yjsManager;
  }

  getWebSocketManager(): WebSocketResourceManager {
    return this.wsManager;
  }

  recordNavigation(): void {
    this.navigationCount++;

    if (this.navigationCount % this.maxNavigationsBeforeWarning === 0) {
      this.diagnoseMemoryUsage();
    }
  }

  disposeRouteResources(): void {
    this.recordNavigation();
    this.mapboxManager.dispose();
  }

  private diagnoseMemoryUsage(): void {
    const mem = (typeof performance !== 'undefined'
      ? (performance as unknown as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory
      : undefined);
    if (mem) {
      const used = mem.usedJSHeapSize;
      const limit = mem.jsHeapSizeLimit;
      const percentage = (used / limit) * 100;

      if (percentage > 80) {
        console.warn(
          `High memory usage detected: ${percentage.toFixed(1)}% (${(used / 1048576).toFixed(1)}MB / ${(limit / 1048576).toFixed(1)}MB)`,
        );
      }
    }
  }

  disposeAll(): void {
    this.mapboxManager.dispose();
    this.yjsManager.dispose();
    this.wsManager.dispose();
    this.navigationCount = 0;
  }

  getHealthReport(): {
    navigationCount: number;
    mapboxDisposed: boolean;
    yjsDisposed: boolean;
    wsDisposed: boolean;
    memoryUsagePercent: number;
  } {
    const mem = (typeof performance !== 'undefined'
      ? (performance as unknown as { memory?: { usedJSHeapSize?: number; jsHeapSizeLimit?: number } }).memory
      : undefined);
    const memUsage = mem?.usedJSHeapSize || 0;
    const memLimit = mem?.jsHeapSizeLimit || 1;

    return {
      navigationCount: this.navigationCount,
      mapboxDisposed: this.mapboxManager.isDisposed(),
      yjsDisposed: this.yjsManager.isDisposed(),
      wsDisposed: this.wsManager.isDisposed(),
      memoryUsagePercent: (memUsage / memLimit) * 100,
    };
  }
}

export {
  MapboxGLResourceManager,
  YjsResourceManager,
  WebSocketResourceManager,
  CrossRouteResourceManager,
  ResourceHandle,
};
