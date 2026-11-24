/**
 * Reduced-Motion Safety Manager (ISP-097 / WCAG 2.3.3).
 *
 * Disables non-essential animation, SMIL vector loops, and video autoplay
 * when the user has expressed a preference for reduced motion.
 */

export function isPrefersReducedMotion() {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function subscribeToReducedMotion(callback) {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

  const listener = (event) => {
    callback(event.matches);
  };

  if (mediaQuery.addEventListener) {
    mediaQuery.addEventListener("change", listener);
    return () => mediaQuery.removeEventListener("change", listener);
  } else if (mediaQuery.addListener) {
    mediaQuery.addListener(listener);
    return () => mediaQuery.removeListener(listener);
  }

  return () => {};
}

/**
 * Returns static fallback properties if reduced motion is requested.
 */
export function getMotionConfig(animationDurationMs = 300) {
  const reduced = isPrefersReducedMotion();
  return {
    isReduced: reduced,
    durationMs: reduced ? 0 : animationDurationMs,
    autoplay: !reduced,
  };
}
