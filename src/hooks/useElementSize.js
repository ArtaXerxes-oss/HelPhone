import { useEffect, useState } from 'react';

/** Observe an element's CSS pixel size (used to keep the cluster grid in sync). */
export function useElementSize(ref, { width: fallbackWidth = 1140, height: fallbackHeight = 540 } = {}) {
  const [size, setSize] = useState({ width: fallbackWidth, height: fallbackHeight });

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      setSize((prev) =>
        prev.width === Math.round(rect.width) && prev.height === Math.round(rect.height)
          ? prev
          : { width: Math.round(rect.width), height: Math.round(rect.height) },
      );
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);

  return size;
}

export default useElementSize;
