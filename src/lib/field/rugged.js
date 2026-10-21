/**
 * Rugged-mode detection + persistence (ISP-131). When enabled, `data-rugged`
 * is set on <html> and Help.css override rules enlarge every interactive
 * target to >=48px and boost contrast for sunlight readability. Single-flag
 * rollback via FEATURE_FLAGS.ruggedMode.
 */

import { isFlagEnabled } from "./flags";

const STORAGE_KEY = "hp_rugged";

const RUGGED_UA =
  /sonim|kyocera|duraforce|cat s\d+|rugged|xcover|shield.*rugged|defy/i;

export function detectRuggedDevice(win = globalThis) {
  try {
    const nav = win.navigator || {};
    const ua = nav.userAgent || "";
    if (RUGGED_UA.test(ua)) return true;
    const coarse =
      nav.maxTouchPoints > 1 &&
      win.matchMedia &&
      win.matchMedia("(pointer: coarse)").matches;
    const small = win.screen && win.screen.width <= 480;
    return !!(coarse && small && nav.maxTouchPoints >= 5);
  } catch {
    return false;
  }
}

export function getRuggedMode(win = globalThis) {
  if (!isFlagEnabled("ruggedMode")) return false;
  try {
    const stored = win.localStorage.getItem(STORAGE_KEY);
    if (stored === "1") return true;
    if (stored === "0") return false;
  } catch {
    // best-effort — surface failures are non-fatal here
  }
  return detectRuggedDevice(win);
}

export function setRuggedMode(on, win = globalThis) {
  try {
    win.localStorage.setItem(STORAGE_KEY, on ? "1" : "0");
  } catch {
    // best-effort — surface failures are non-fatal here
  }
  applyRuggedDom(on, win);
  return !!on;
}

export function applyRuggedDom(on, win = globalThis) {
  try {
    const root = win.document && win.document.documentElement;
    if (!root) return;
    if (on) root.setAttribute("data-rugged", "1");
    else root.removeAttribute("data-rugged");
  } catch {
    // best-effort — surface failures are non-fatal here
  }
}
