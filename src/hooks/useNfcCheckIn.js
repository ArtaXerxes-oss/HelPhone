/**
 * useNfcCheckIn — NDEFReader lifecycle for staging tags with a first-class
 * QR/short-code fallback for devices without NFC. Scans abort on unmount
 * and on every dismissal path; offline intents are queued exactly-once via
 * the shared offline queue.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fieldConfirm } from "../lib/field/audioAlert";
import { isFlagEnabled } from "../lib/field/flags";
import { enqueue, PRIO } from "../lib/field/offlineQueue";
import { postSwMessage } from "../lib/field/swChannel";
import {
  NDEF_MIME,
  NDEF_TEXT_PREFIX,
  createCheckInOutStore,
  createStagingRegistry,
  verifyStagingPayload,
} from "../lib/nfc/stagingTag";

const ROSTER_STORAGE = "hp_staging_roster";
const FALLBACK_RATE_LIMIT = 5;
const FALLBACK_WINDOW_MS = 60000;

export function useNfcCheckIn({
  responderId = "anonymous",
  secretHex = "helphone-staging-dev-secret",
  stagingRegistry = null,
  onAccepted = null,
} = {}) {
  const supported = typeof window !== "undefined" && "NDEFReader" in window;
  const enabled = isFlagEnabled("nfcCheckIn");
  const [scanning, setScanning] = useState(false);
  const [lastResult, setLastResult] = useState(null);
  const [roster, setRoster] = useState(() => loadRoster());
  const [rateLimited, setRateLimited] = useState(false);
  const abortRef = useRef(null);
  const registryRef = useRef(stagingRegistry || createStagingRegistry());
  const storeRef = useRef(null);
  if (!storeRef.current) {
    storeRef.current = createCheckInOutStore();
    hydrateStore(storeRef.current, roster);
  }

  const stopScan = useCallback(() => {
    try {
      if (abortRef.current) abortRef.current.abort();
    } catch {
      // best-effort — surface failures are non-fatal here
    }
    abortRef.current = null;
    setScanning(false);
  }, []);

  useEffect(() => stopScan, [stopScan]);

  const applyResult = useCallback(
    (result) => {
      setLastResult(result);
      if (
        result.status === "accepted" ||
        result.status === "duplicate_suppressed"
      ) {
        setRoster(storeRef.current.roster());
        persistRoster(storeRef.current.roster());
        fieldConfirm({ loud: result.status === "accepted" });
        postSwMessage("HELPHONE_NFC_RESULT", result);
        if (onAccepted) onAccepted(result);
      }
      return result;
    },
    [onAccepted],
  );

  const processIntent = useCallback(
    async ({ stagingId, nonce = null, source }) => {
      const result = storeRef.current.checkInOut({
        responderId,
        stagingId,
        direction: "IN",
        nonce,
      });
      const enriched = {
        ...result,
        source,
        responderId,
        stagingId,
        queued: false,
      };
      if (result.status === "accepted") {
        const { entry, duplicate } = enqueue({
          kind: "staging",
          prio: PRIO.ROSTER,
          idempotencyKey: `${responderId}:${stagingId}:IN:${nonce || enriched.entry.at}`,
          data: { ...enriched.entry, source },
        });
        enriched.queued = !duplicate;
        enriched.queueId = entry.id;
      }
      return applyResult(enriched);
    },
    [applyResult, responderId],
  );

  const startScan = useCallback(async () => {
    if (!enabled || !supported) return false;
    stopScan();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const reader = new window.NDEFReader();
      await reader.scan({ signal: controller.signal });
      setScanning(true);
      reader.addEventListener("reading", async ({ message }) => {
        try {
          const record = [...message.records].find(
            (r) =>
              r.mediaType === NDEF_MIME ||
              (r.recordType === "text" &&
                new TextDecoder().decode(r.data).startsWith(NDEF_TEXT_PREFIX)),
          );
          if (!record) {
            setLastResult({ status: "rejected", reason: "unknown-record" });
            return;
          }
          const text = new TextDecoder().decode(record.data);
          const json =
            record.mediaType === NDEF_MIME
              ? text
              : text.slice(NDEF_TEXT_PREFIX.length);
          const verification = await verifyStagingPayload(json, secretHex);
          if (!verification.valid) {
            setLastResult({
              status: "rejected",
              reason: verification.reason || "tamper",
            });
            fieldConfirm({ haptic: true, tone: false });
            return;
          }
          await processIntent({
            stagingId: verification.record.stagingId,
            nonce: verification.record.nonce,
            source: "nfc",
          });
        } catch (err) {
          setLastResult({
            status: "rejected",
            reason: String((err && err.message) || err),
          });
        }
      });
      reader.addEventListener("readingerror", () => {
        setLastResult({ status: "rejected", reason: "read-error" });
      });
      return true;
    } catch (err) {
      setScanning(false);
      setLastResult({
        status: "rejected",
        reason: String((err && err.message) || err),
      });
      return false;
    }
  }, [enabled, processIntent, secretHex, stopScan, supported]);

  const fallbackTimestamps = useRef([]);

  const submitFallbackCode = useCallback(
    async (code, { insideGeofence = true } = {}) => {
      const now = Date.now();
      fallbackTimestamps.current = fallbackTimestamps.current.filter(
        (t) => now - t < FALLBACK_WINDOW_MS,
      );
      if (fallbackTimestamps.current.length >= FALLBACK_RATE_LIMIT) {
        setRateLimited(true);
        setTimeout(() => setRateLimited(false), FALLBACK_WINDOW_MS);
        return { status: "rejected", reason: "rate-limited" };
      }
      fallbackTimestamps.current.push(now);
      if (!insideGeofence) {
        return { status: "rejected", reason: "outside-geofence" };
      }
      const stagingId = registryRef.current.resolve(code);
      if (!stagingId) {
        setLastResult({ status: "rejected", reason: "unknown-code" });
        return { status: "rejected", reason: "unknown-code" };
      }
      return processIntent({
        stagingId,
        nonce: `fb-${now}-${code}`,
        source: "fallback",
      });
    },
    [processIntent],
  );

  const unmatched = useMemo(() => storeRef.current.unmatchedIns(), [roster]);

  return {
    supported,
    enabled,
    scanning,
    startScan,
    stopScan,
    submitFallbackCode,
    roster,
    lastResult,
    rateLimited,
    unmatched,
    registerStaging: (stagingId, code) =>
      registryRef.current.register(stagingId, code),
  };
}

function loadRoster() {
  try {
    const v = JSON.parse(localStorage.getItem(ROSTER_STORAGE) || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function persistRoster(roster) {
  try {
    localStorage.setItem(ROSTER_STORAGE, JSON.stringify(roster.slice(0, 200)));
  } catch {
    // best-effort — surface failures are non-fatal here
  }
}

function hydrateStore(store, roster) {
  for (const entry of roster) {
    store.checkInOut({ ...entry, ts: entry.at });
  }
}
