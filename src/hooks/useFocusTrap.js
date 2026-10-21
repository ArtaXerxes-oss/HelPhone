import { useEffect, useRef } from "react";

/**
 * useFocusTrap — lightweight focus trap utility (no external dependency).
 *
 * Traps keyboard navigation (Tab / Shift+Tab) within the container element
 * when `active` is true. Also moves initial focus to the first interactive
 * element inside the container on activation.
 *
 * Acceptance:
 * - Apply to all modal / dialog components
 * - Ensure initial focus is set to first interactive element
 *
 * @param {boolean} active — whether trap is active (modal open)
 * @param {import('react').RefObject<HTMLElement>} containerRef — dialog element ref
 */
export function useFocusTrap(active, containerRef) {
  const previousFocusRef = useRef(null);

  useEffect(() => {
    if (!active) return undefined;
    const container = containerRef.current;
    if (!container) return undefined;

    // Store element that had focus before modal opened
    previousFocusRef.current = document.activeElement;

    const FOCUSABLE_SELECTOR =
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

    const getFocusable = () => {
      if (!container) return [];
      const nodes = Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR));
      // Filter out hidden/inert elements
      return nodes.filter((el) => {
        if (el.hasAttribute("disabled")) return false;
        if (el.getAttribute("aria-hidden") === "true") return false;
        // offsetParent null means hidden, but keep if it is the activeElement
        return true;
      });
    };

    // Focus first interactive element, fallback to container
    const focusable = getFocusable();
    if (focusable.length > 0) {
      focusable[0].focus();
    } else if (container.getAttribute("tabindex") !== null) {
      container.focus();
    } else {
      container.setAttribute("tabindex", "-1");
      container.focus();
    }

    function handleKeyDown(e) {
      if (e.key !== "Tab") return;
      const focusableElements = getFocusable();
      if (focusableElements.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusableElements[0];
      const last = focusableElements[focusableElements.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      // Restore focus to triggering element (WCAG: focus return)
      if (previousFocusRef.current instanceof HTMLElement) {
        try {
          previousFocusRef.current.focus();
        } catch {}
      }
    };
  }, [active, containerRef]);
}

/**
 * useFocusTrapWithRestore — variant that also restores focus to trigger on unmount/close.
 * Used when escape handling is managed separately (issue #92). If you want combined
 * behavior, use this hook instead of useFocusTrap + manual restore.
 */
export function useFocusTrapWithRestore(active, containerRef) {
  const previousFocusRef = useRef(null);
  useEffect(() => {
    if (!active) return undefined;
    previousFocusRef.current = document.activeElement;
    return () => {
      if (previousFocusRef.current instanceof HTMLElement) {
        previousFocusRef.current.focus();
      }
    };
  }, [active]);

  useFocusTrap(active, containerRef);
}

export default useFocusTrap;
