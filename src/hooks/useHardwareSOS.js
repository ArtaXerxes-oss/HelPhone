/**
 * Hardware SOS / PTT wiring for rugged devices (ISP-131).
 *
 * - SOS: hardware red key (Android keycode 249) or media "previoustrack" —
 *   1.2s hold commits exactly one escalated dispatch; short presses and
 *   pocket bounce are ignored. A second press inside the dedupe window
 *   cannot create a second incident (idempotency key).
 * - PTT: media play/pause or keycode 250 — toggles presence, never creates
 *   an incident.
 * - Pocket-press outside the incident geofence never auto-dispatches: the
 *   hook emits "needs-confirm" and the full-screen SosSheet takes over.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { sosAlert, fieldConfirm } from "../lib/field/audioAlert";
import { isFlagEnabled } from "../lib/field/flags";
import { enqueue, findByIdempotencyKey, PRIO } from "../lib/field/offlineQueue";
import { postSwMessage } from "../lib/field/swChannel";

export const SOS_HOLD_MS = 1200;
export const SOS_DEDUPE_MS = 10000;
export const KEY_SOS = 249;
export const KEY_PTT = 250;
export const KEY_MEDIA_TOGGLE = 179;

/**
 * Pure press classifier — unit-testable without DOM.
 * @returns {'commit'|'ptt'|'ignored'}
 */
export function classifyPress(startTs, endTs, holdMs = SOS_HOLD_MS) {
  if (startTs == null || endTs == null) return "ignored";
  const held = endTs - startTs;
  if (held >= holdMs) return "commit";
  if (held >= 60 && held < 300) return "ptt";
  return "ignored";
}

export function sosIdempotencyKey(now = Date.now(), windowMs = SOS_DEDUPE_MS) {
  return `sos-${Math.floor(now / windowMs)}`;
}

export function useHardwareSOS({
  enabled = true,
  canAutoDispatch = () => true,
  onCommit = null,
  onPttToggle = null,
  onNeedsConfirm = null,
} = {}) {
  const flagOn = isFlagEnabled("hardwareSos") && enabled;
  const [pttActive, setPttActive] = useState(false);
  const [armed, setArmed] = useState(false);
  const [progress, setProgress] = useState(0);
  const [lastCommitAt, setLastCommitAt] = useState(null);
  const holdStartRef = useRef(null);
  const rafRef = useRef(null);

  const commit = useCallback(
    ({ source = "hardware", force = false } = {}) => {
      const now = Date.now();
      const idempotencyKey = sosIdempotencyKey(now);
      const existing = findByIdempotencyKey(idempotencyKey);
      if (existing) {
        return { duplicate: true, entry: existing };
      }
      if (!force && !canAutoDispatch()) {
        if (onNeedsConfirm) onNeedsConfirm({ idempotencyKey, source, ts: now });
        sosAlert();
        return { needsConfirm: true, idempotencyKey };
      }
      const { entry, duplicate } = enqueue({
        kind: "sos",
        prio: PRIO.SOS,
        idempotencyKey,
        data: { ts: now, source },
      });
      sosAlert();
      postSwMessage("HELPHONE_SOS", { idempotencyKey, ts: now, source });
      setLastCommitAt(now);
      if (onCommit) onCommit({ entry, duplicate, idempotencyKey, source });
      return { entry, duplicate };
    },
    [canAutoDispatch, onCommit, onNeedsConfirm],
  );

  const togglePtt = useCallback(() => {
    setPttActive((prev) => {
      const next = !prev;
      fieldConfirm({ haptic: true, tone: false });
      if (onPttToggle) onPttToggle(next);
      return next;
    });
  }, [onPttToggle]);

  useEffect(() => {
    if (!flagOn) return undefined;

    const tick = () => {
      if (holdStartRef.current == null) return;
      const elapsed = Date.now() - holdStartRef.current;
      setProgress(Math.min(1, elapsed / SOS_HOLD_MS));
      if (elapsed >= SOS_HOLD_MS && !rafRef.current) {
        // Held long enough — commit on release; keep ring full meanwhile.
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    const onKeyDown = (e) => {
      if (e.repeat) return;
      if (e.keyCode === KEY_SOS || e.key === "SOS") {
        e.preventDefault();
        if (holdStartRef.current == null) {
          holdStartRef.current = Date.now();
          setArmed(true);
          setProgress(0);
          rafRef.current = requestAnimationFrame(tick);
        }
      } else if (e.keyCode === KEY_PTT) {
        e.preventDefault();
        togglePtt();
      }
    };

    const onKeyUp = (e) => {
      if (e.keyCode === KEY_SOS || e.key === "SOS") {
        const start = holdStartRef.current;
        holdStartRef.current = null;
        if (rafRef.current) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
        setArmed(false);
        setProgress(0);
        const kind = classifyPress(start, Date.now());
        if (kind === "commit") commit({ source: "hardware-key" });
      }
    };

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);

    let mediaHandlers = false;
    try {
      const ms = navigator.mediaSession;
      if (ms && typeof ms.setActionHandler === "function") {
        ms.setActionHandler("previoustrack", () => {
          // No hold semantics via mediaSession — route to confirm sheet.
          if (onNeedsConfirm) {
            sosAlert();
            onNeedsConfirm({
              idempotencyKey: sosIdempotencyKey(),
              source: "media-key",
              ts: Date.now(),
            });
          } else {
            commit({ source: "media-key" });
          }
        });
        ms.setActionHandler("playpause", () => togglePtt());
        mediaHandlers = true;
      }
    } catch {
      // best-effort — surface failures are non-fatal here
    }

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (mediaHandlers) {
        try {
          navigator.mediaSession.setActionHandler("previoustrack", null);
          navigator.mediaSession.setActionHandler("playpause", null);
        } catch {
          // best-effort — surface failures are non-fatal here
        }
      }
    };
  }, [flagOn, commit, togglePtt, onNeedsConfirm]);

  return {
    enabled: flagOn,
    armed,
    progress,
    pttActive,
    lastCommitAt,
    commit,
    togglePtt,
  };
}
