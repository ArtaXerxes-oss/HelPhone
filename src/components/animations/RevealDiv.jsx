import { useEffect, useRef, useState } from "react";

/**
 * RevealDiv — scroll-triggered reveal animation.
 *
 * Extracted from inline definition in App.jsx to avoid remounting on every
 * render. Each instance manages its own IntersectionObserver so the parent
 * does not need to maintain a visibleElements Set or index counter.
 *
 * Props
 * - children: content to reveal
 * - index: legacy prop (ignored, kept for backward compatibility)
 * - delay: optional transition delay in ms
 * - isVisible: optional controlled visibility flag (if provided, observer is bypassed)
 * - style, className, ...rest: passed to wrapper div
 */
export default function RevealDiv({
  children,
  index,
  delay = 0,
  isVisible,
  style,
  className,
  ...props
}) {
  const ref = useRef(null);
  const [visible, setVisible] = useState(() => {
    // If controlled, respect parent value immediately
    if (typeof isVisible === "boolean") return isVisible;
    return false;
  });

  // Sync controlled mode
  useEffect(() => {
    if (typeof isVisible === "boolean") setVisible(isVisible);
  }, [isVisible]);

  useEffect(() => {
    // Controlled mode — no observer needed
    if (typeof isVisible === "boolean") return;

    const el = ref.current;
    if (!el) return;

    const vh = typeof window !== "undefined" ? window.innerHeight || 800 : 800;

    // Immediately show if already above the fold
    try {
      const rect = el.getBoundingClientRect();
      if (rect.top <= vh * 0.85) {
        setVisible(true);
        return;
      }
    } catch {
      // ignore
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setVisible(true);
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -7% 0px" },
    );

    observer.observe(el);

    // Fallback: ensure content becomes visible even if observer fails
    const timeout = setTimeout(() => setVisible(true), 4500);

    return () => {
      observer.disconnect();
      clearTimeout(timeout);
    };
  }, [isVisible]);

  const mergedStyle = {
    opacity: visible ? 1 : 0,
    transform: visible ? "none" : "translateY(30px)",
    transition: delay
      ? `opacity 1.05s cubic-bezier(0.22, 0.75, 0.2, 1) ${delay}ms, transform 1.05s cubic-bezier(0.22, 0.75, 0.2, 1) ${delay}ms`
      : "opacity 1.05s cubic-bezier(0.22, 0.75, 0.2, 1), transform 1.05s cubic-bezier(0.22, 0.75, 0.2, 1)",
    ...style,
  };

  return (
    <div
      ref={ref}
      data-reveal
      className={className}
      style={mergedStyle}
      {...props}
    >
      {children}
    </div>
  );
}
