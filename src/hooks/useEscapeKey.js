import { useEffect, useRef } from "react";

/**
 * useEscapeKey — closes modal on Escape and restores focus to trigger element.
 *
 * - Adds global document-level keydown listener when active
 * - Calls onClose when Escape is pressed
 * - Restores focus to the element that had focus before modal opened
 *
 * @param {boolean} active — whether modal is open
 * @param {() => void} onClose — close handler
 */
export function useEscapeKey(active, onClose) {
  const previousFocusRef = useRef(null);

  useEffect(() => {
    if (!active) return undefined;
    previousFocusRef.current = document.activeElement;

    function handleKeyDown(e) {
      if (e.key === "Escape" && typeof onClose === "function") {
        e.stopPropagation();
        onClose();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      // Restore focus to triggering element after close
      if (previousFocusRef.current instanceof HTMLElement) {
        // Use microtask to avoid conflict with focus trap cleanup
        queueMicrotask(() => {
          if (previousFocusRef.current instanceof HTMLElement) {
            try {
              previousFocusRef.current.focus();
            } catch {}
          }
        });
      }
    };
  }, [active, onClose]);
}

export default useEscapeKey;
