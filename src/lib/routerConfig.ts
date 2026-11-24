import { useEffect, useRef } from 'react';

interface RouterConfig {
  futureFlags: {
    v7_startTransition: boolean;
    v7_relativeSplatPath: boolean;
    v7_fetcherPersist: boolean;
    v7_normalizeFormMethod: boolean;
    v7_prependBasename: boolean;
  };
  scrollRestoration: ScrollRestorationConfig;
  anchorNavigation: AnchorNavConfig;
  modalDeepLinks: ModalDeepLinkConfig;
  pwaIntegration: PWAIntegrationConfig;
}

interface ScrollRestorationConfig {
  enabled: boolean;
  behavior: 'auto' | 'smooth';
  restoreOnBackNavigation: boolean;
  savePositionOnNavigate: boolean;
}

interface AnchorNavConfig {
  enabled: boolean;
  smoothScroll: boolean;
  offset: number;
  highlightDuration: number;
}

interface ModalDeepLinkConfig {
  enabled: boolean;
  preserveModalStateOnRefresh: boolean;
  modalStorageKey: string;
}

interface PWAIntegrationConfig {
  startUrl: string;
  scope: string;
  preventScopeEscape: boolean;
  restoreNavigationOnReload: boolean;
}

export const defaultRouterConfig: RouterConfig = {
  futureFlags: {
    v7_startTransition: true,
    v7_relativeSplatPath: true,
    v7_fetcherPersist: true,
    v7_normalizeFormMethod: true,
    v7_prependBasename: true,
  },
  scrollRestoration: {
    enabled: true,
    behavior: 'auto',
    restoreOnBackNavigation: true,
    savePositionOnNavigate: true,
  },
  anchorNavigation: {
    enabled: true,
    smoothScroll: true,
    offset: 80,
    highlightDuration: 1500,
  },
  modalDeepLinks: {
    enabled: true,
    preserveModalStateOnRefresh: true,
    modalStorageKey: 'helphone_modal_state',
  },
  pwaIntegration: {
    startUrl: '/',
    scope: '/',
    preventScopeEscape: true,
    restoreNavigationOnReload: true,
  },
};

interface ScrollPosition {
  pathname: string;
  scrollY: number;
  timestamp: number;
}

class ScrollRestorationManager {
  private scrollPositions: Map<string, ScrollPosition> = new Map();
  private windowScrollRef = { x: 0, y: 0 };
  private config: ScrollRestorationConfig;
  private saveTimeoutId: NodeJS.Timeout | null = null;

  constructor(config: ScrollRestorationConfig) {
    this.config = config;
  }

  initialize(pathname: string): void {
    if (!this.config.enabled) return;

    window.addEventListener('scroll', this.handleScroll.bind(this), { passive: true });
    window.addEventListener('popstate', this.handlePopState.bind(this));
  }

  savePosition(pathname: string): void {
    if (!this.config.savePositionOnNavigate) return;

    if (this.saveTimeoutId) clearTimeout(this.saveTimeoutId);

    this.saveTimeoutId = setTimeout(() => {
      this.scrollPositions.set(pathname, {
        pathname,
        scrollY: window.scrollY,
        timestamp: Date.now(),
      });
    }, 100);
  }

  restorePosition(pathname: string): void {
    if (!this.config.restoreOnBackNavigation) return;

    const position = this.scrollPositions.get(pathname);
    if (position) {
      setTimeout(() => {
        window.scrollTo({
          top: position.scrollY,
          left: 0,
          behavior: this.config.behavior,
        });
      }, 0);
    }
  }

  private handleScroll(): void {
    this.windowScrollRef = { x: window.scrollX, y: window.scrollY };
  }

  private handlePopState(): void {
    const currentPath = window.location.pathname;
    this.restorePosition(currentPath);
  }

  clear(): void {
    window.removeEventListener('scroll', this.handleScroll);
    window.removeEventListener('popstate', this.handlePopState);
    if (this.saveTimeoutId) clearTimeout(this.saveTimeoutId);
    this.scrollPositions.clear();
  }
}

class AnchorNavigationManager {
  private config: AnchorNavConfig;
  private highlightedElement: HTMLElement | null = null;
  private highlightTimeoutId: NodeJS.Timeout | null = null;

  constructor(config: AnchorNavConfig) {
    this.config = config;
  }

  initialize(): void {
    if (!this.config.enabled) return;

    document.addEventListener('click', this.handleAnchorClick.bind(this));
  }

  private handleAnchorClick(event: MouseEvent): void {
    const target = (event.target as HTMLElement).closest('a');
    if (!target) return;

    const href = target.getAttribute('href');
    if (!href || !href.startsWith('#')) return;

    event.preventDefault();
    const elementId = href.substring(1);
    const element = document.getElementById(elementId);

    if (element) {
      const scrollBehavior: ScrollBehavior = this.config.smoothScroll ? 'smooth' : 'auto';
      const offsetTop = element.getBoundingClientRect().top + window.scrollY - this.config.offset;

      window.scrollTo({
        top: offsetTop,
        behavior: scrollBehavior,
      });

      this.highlightElement(element);
      window.history.replaceState(null, '', href);
    }
  }

  private highlightElement(element: HTMLElement): void {
    if (this.highlightedElement) {
      this.highlightedElement.classList.remove('anchor-highlight');
    }

    element.classList.add('anchor-highlight');
    this.highlightedElement = element;

    if (this.highlightTimeoutId) clearTimeout(this.highlightTimeoutId);
    this.highlightTimeoutId = setTimeout(() => {
      element.classList.remove('anchor-highlight');
      this.highlightedElement = null;
    }, this.config.highlightDuration);
  }

  dispose(): void {
    document.removeEventListener('click', this.handleAnchorClick);
    if (this.highlightTimeoutId) clearTimeout(this.highlightTimeoutId);
  }
}

class ModalDeepLinkManager {
  private config: ModalDeepLinkConfig;
  private modalState: Record<string, unknown> = {};

  constructor(config: ModalDeepLinkConfig) {
    this.config = config;
  }

  initialize(): void {
    if (!this.config.enabled) return;

    this.restoreModalState();
    window.addEventListener('beforeunload', this.saveModalState.bind(this));
  }

  saveModalState(state: Record<string, unknown>): void {
    if (!this.config.preserveModalStateOnRefresh) return;

    this.modalState = state;
    try {
      sessionStorage.setItem(this.config.modalStorageKey, JSON.stringify(state));
    } catch (e) {
      console.warn('Failed to save modal state:', e);
    }
  }

  private restoreModalState(): void {
    try {
      const stored = sessionStorage.getItem(this.config.modalStorageKey);
      if (stored) {
        this.modalState = JSON.parse(stored);
        sessionStorage.removeItem(this.config.modalStorageKey);
      }
    } catch (e) {
      console.warn('Failed to restore modal state:', e);
    }
  }

  getModalState(): Record<string, unknown> {
    return this.modalState;
  }

  dispose(): void {
    window.removeEventListener('beforeunload', this.saveModalState);
  }
}

class PWANavigationManager {
  private config: PWAIntegrationConfig;

  constructor(config: PWAIntegrationConfig) {
    this.config = config;
  }

  initialize(): void {
    if (!this.config.preventScopeEscape) return;

    window.addEventListener('popstate', this.handleNavigation.bind(this));
    window.addEventListener('click', this.preventScopeEscape.bind(this));
  }

  private preventScopeEscape(event: MouseEvent): void {
    const target = (event.target as HTMLElement).closest('a');
    if (!target) return;

    const href = target.getAttribute('href');
    if (!href) return;

    try {
      const url = new URL(href, window.location.href);
      const scopePath = new URL(this.config.scope, window.location.href).pathname;
      const linkPath = url.pathname;

      if (!linkPath.startsWith(scopePath)) {
        console.warn(`Navigation outside PWA scope (${this.config.scope}) blocked: ${href}`);
        event.preventDefault();
        return;
      }
    } catch (e) {
      console.warn('Failed to validate scope:', e);
    }
  }

  private handleNavigation(): void {
    if (this.config.restoreNavigationOnReload && !window.location.pathname.startsWith(this.config.scope)) {
      window.location.href = this.config.startUrl;
    }
  }

  dispose(): void {
    window.removeEventListener('popstate', this.handleNavigation);
    window.removeEventListener('click', this.preventScopeEscape);
  }
}

export {
  ScrollRestorationManager,
  AnchorNavigationManager,
  ModalDeepLinkManager,
  PWANavigationManager,
  RouterConfig,
};
