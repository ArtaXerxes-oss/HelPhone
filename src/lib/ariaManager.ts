/**
 * Manages a singleton pair of `aria-live` DOM regions ("polite" and
 * "assertive") so screen readers announce dynamic status changes
 * (responder arrival, request state transitions) without requiring
 * focus to move.
 */

type Politeness = 'polite' | 'assertive';

class AriaLiveManager {
  private regions: Map<Politeness, HTMLElement> = new Map();
  private clearTimers: Map<Politeness, ReturnType<typeof setTimeout>> = new Map();

  private ensureRegion(politeness: Politeness): HTMLElement {
    let region = this.regions.get(politeness);
    if (region && document.body.contains(region)) {
      return region;
    }

    region = document.createElement('div');
    region.setAttribute('aria-live', politeness);
    region.setAttribute('aria-atomic', 'true');
    region.setAttribute('role', politeness === 'assertive' ? 'alert' : 'status');
    region.style.position = 'absolute';
    region.style.width = '1px';
    region.style.height = '1px';
    region.style.overflow = 'hidden';
    region.style.clip = 'rect(0,0,0,0)';
    region.style.whiteSpace = 'nowrap';
    region.id = `aria-live-${politeness}`;

    document.body.appendChild(region);
    this.regions.set(politeness, region);
    return region;
  }

  /**
   * Announce `message` via the given politeness level. Clears and
   * re-sets the text on a microtask delay so repeated identical
   * announcements are still picked up by assistive tech (which
   * otherwise ignores unchanged text nodes).
   */
  announce(message: string, politeness: Politeness = 'polite'): void {
    const region = this.ensureRegion(politeness);

    const existingTimer = this.clearTimers.get(politeness);
    if (existingTimer) clearTimeout(existingTimer);

    region.textContent = '';
    // Force a reflow before re-adding text so identical consecutive
    // announcements are re-read.
    requestAnimationFrame(() => {
      region.textContent = message;
    });

    const timer = setTimeout(() => {
      region.textContent = '';
    }, 5000);
    this.clearTimers.set(politeness, timer);
  }

  destroy(): void {
    for (const region of this.regions.values()) {
      region.remove();
    }
    for (const timer of this.clearTimers.values()) {
      clearTimeout(timer);
    }
    this.regions.clear();
    this.clearTimers.clear();
  }
}

export const ariaManager = new AriaLiveManager();

export function announceStatus(message: string): void {
  ariaManager.announce(message, 'polite');
}

export function announceUrgent(message: string): void {
  ariaManager.announce(message, 'assertive');
}
