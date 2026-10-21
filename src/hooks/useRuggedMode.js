/**
 * useRuggedMode — detection + persistence + DOM attribute for glove-target
 * and sunlight-contrast overrides (ISP-131). Rollback: feature flag off or
 * toggle in the Help profile menu restores stock layout with one re-render.
 */

import { useCallback, useEffect, useState } from "react";
import {
  applyRuggedDom,
  getRuggedMode,
  setRuggedMode,
} from "../lib/field/rugged";

export function useRuggedMode() {
  const [enabled, setEnabled] = useState(() => getRuggedMode());

  useEffect(() => {
    applyRuggedDom(enabled);
  }, [enabled]);

  const toggle = useCallback(() => {
    setEnabled((prev) => setRuggedMode(!prev));
  }, []);

  const set = useCallback((on) => {
    setEnabled(setRuggedMode(!!on));
  }, []);

  return { enabled, toggle, set };
}
