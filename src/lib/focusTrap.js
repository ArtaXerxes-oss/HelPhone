/**
 * Accessible Modal Focus Trap and Escape Management (ISP-097 / WCAG 2.4.3 & 2.1.2).
 */

export class FocusTrap {
  constructor(containerElement, options = {}) {
    this.container = containerElement;
    this.invokerElement = options.invokerElement || document.activeElement;
    this.onEscape = options.onEscape;
    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.focusableSelector =
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
  }

  activate() {
    if (!this.container) return;
    document.addEventListener("keydown", this.handleKeyDown);

    // Focus first focusable element inside modal
    const focusable = this.getFocusableElements();
    if (focusable.length > 0) {
      focusable[0].focus();
    } else {
      this.container.focus();
    }
  }

  deactivate() {
    document.removeEventListener("keydown", this.handleKeyDown);
    if (this.invokerElement && typeof this.invokerElement.focus === "function") {
      this.invokerElement.focus();
    }
  }

  getFocusableElements() {
    if (!this.container) return [];
    return Array.from(this.container.querySelectorAll(this.focusableSelector));
  }

  handleKeyDown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      this.onEscape?.();
      return;
    }

    if (event.key !== "Tab") return;

    const focusable = this.getFocusableElements();
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (event.shiftKey) {
      if (document.activeElement === first) {
        event.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }
}
