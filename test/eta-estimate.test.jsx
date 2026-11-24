/** ADR-022 ETA estimator, flag and degraded-display tests. */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { EtaLabel, DegradedEtaNotice } from "../src/components/EtaLabel";
import {
  isFeatureEnabled,
  isPredictiveEtaV2Enabled,
  setFeatureOverride,
} from "../src/lib/featureFlags";
import {
  estimateEta,
  formatEta,
  haversineKm,
  rankByRealisticEta,
  toEtaEstimate,
} from "../src/lib/etaEstimate";
import {
  FITTED_ETA_CONSTANTS,
  LEGACY_ETA_CONSTANTS,
} from "../src/lib/etaConstants";

beforeEach(() => setFeatureOverride("predictiveEtaV2", null));
afterEach(() => {
  setFeatureOverride("predictiveEtaV2", null);
  cleanup();
});

describe("estimateEta", () => {
  it("returns the documented shape", () => {
    const e = estimateEta({ etaSeconds: 900 });
    expect(e).toHaveProperty("min");
    expect(e).toHaveProperty("max");
    expect(e).toHaveProperty("confidence");
    expect(e).toHaveProperty("degraded");
    expect(e).toHaveProperty("label");
  });

  it("keeps min <= max", () => {
    for (const seconds of [60, 300, 900, 3600]) {
      const e = estimateEta({ etaSeconds: seconds });
      expect(e.min).toBeLessThanOrEqual(e.max);
    }
  });

  it("marks offline estimates degraded", () => {
    const e = estimateEta({ etaSeconds: 900, trafficAware: false });
    expect(e.degraded).toBe(true);
    expect(e.confidence).toBe('low')
    expect(e.confidenceScore).toBe(FITTED_ETA_CONSTANTS.minConfidence);
  });

  it("marks a forced Mapbox failure degraded", () => {
    expect(estimateEta({ etaSeconds: 900, mapboxFailed: true }).degraded).toBe(
      true,
    );
  });

  it("widens degraded ranges beyond traffic-aware ones", () => {
    const aware = estimateEta({ etaSeconds: 900, trafficAware: true });
    const offline = estimateEta({ etaSeconds: 900, trafficAware: false });
    expect(offline.max - offline.min).toBeGreaterThan(aware.max - aware.min);
  });

  it("applies fatigue through the estimator only", () => {
    const fresh = estimateEta({ etaSeconds: 900, runs: 0 });
    const tired = estimateEta({ etaSeconds: 900, runs: 10 });
    expect(tired.min).toBeLessThan(fresh.min);
    expect(tired.confidenceScore).toBeLessThanOrEqual(fresh.confidenceScore);
  });

  it("saturates the fatigue bonus", () => {
    const capped = estimateEta({ etaSeconds: 900, runs: 999 });
    expect(capped.min).toBe(
      estimateEta({ etaSeconds: 900, runs: FITTED_ETA_CONSTANTS.runsToCap })
        .min,
    );
  });

  it("falls back to distance when no ETA exists", () => {
    const e = estimateEta({
      distanceKm: 10,
      baseSpeedKmh: 30,
      trafficAware: true,
    });
    expect(e.min).toBeGreaterThan(0);
    expect(e.degraded).toBe(false);
  });

  it("reports unavailable ETA as degraded with a zero range", () => {
    expect(estimateEta({})).toMatchObject({ min: 0, max: 0, degraded: true });
  });

  it("uses fitted constants, not the legacy ones", () => {
    expect(FITTED_ETA_CONSTANTS).not.toEqual(LEGACY_ETA_CONSTANTS);
    expect(estimateEta({ etaSeconds: 900 }).min).not.toBe(
      estimateEta({ etaSeconds: 900 }, LEGACY_ETA_CONSTANTS).min,
    );
  });
});

describe("formatting and ranking", () => {
  it("formats a traffic-aware range", () => {
    expect(
      formatEta({
        min: 8,
        max: 12,
        confidence: 0.9,
        degraded: false,
        label: "",
      }),
    ).toBe("8–12 min");
  });

  it("formats a degraded range with an offline marker", () => {
    expect(
      formatEta({
        min: 12,
        max: 22,
        confidence: 0.45,
        degraded: true,
        label: "",
      }),
    ).toBe("≈12–22 min (offline)");
  });

  it("formats an unavailable estimate", () => {
    expect(
      formatEta({ min: 0, max: 0, confidence: 0, degraded: true, label: "" }),
    ).toBe("ETA unavailable");
  });

  it("toEtaEstimate delegates to the estimator", () => {
    expect(toEtaEstimate(900, { trafficAware: false })).toEqual(
      estimateEta({ etaSeconds: 900, trafficAware: false }),
    );
  });

  it("computes great-circle distance", () => {
    expect(haversineKm([6.5244, 3.3792], [6.5244, 3.3792])).toBeCloseTo(0);
    expect(haversineKm([0, 0], [0, 1])).toBeCloseTo(111.2, 0);
  });

  it("ranks candidates by realistic ETA", () => {
    const candidates = [
      { responder: "far", lat: 6.6, lng: 3.5, eta_seconds: 1800 },
      { responder: "near", lat: 6.53, lng: 3.38, eta_seconds: 300 },
      { responder: "middle", lat: 6.55, lng: 3.42, eta_seconds: 900 },
    ];
    const ranked = rankByRealisticEta(candidates, { lat: 6.5244, lng: 3.3792 });
    expect(ranked.map((r) => r.responder)).toEqual(["near", "middle", "far"]);
  });

  it("keeps ranking stable for equal estimates", () => {
    const candidates = [
      { id: 1, eta_seconds: 600 },
      { id: 2, eta_seconds: 600 },
    ];
    expect(
      rankByRealisticEta(candidates, { lat: 0, lng: 0 }).map((c) => c.id),
    ).toEqual([1, 2]);
  });

  it("does not mutate the input array", () => {
    const candidates = [{ eta_seconds: 900 }, { eta_seconds: 300 }];
    const snapshot = [...candidates];
    rankByRealisticEta(candidates, { lat: 0, lng: 0 });
    expect(candidates).toEqual(snapshot);
  });
});

describe("predictiveEtaV2 flag and rendering", () => {
  it("is off by default", () => {
    expect(isPredictiveEtaV2Enabled()).toBe(false);
    expect(isFeatureEnabled("predictiveEtaV2")).toBe(false);
  });

  it("can be enabled via localStorage override", () => {
    setFeatureOverride("predictiveEtaV2", true);
    expect(isPredictiveEtaV2Enabled()).toBe(true);
  });

  it("flag-off output is byte-identical to the legacy label", () => {
    render(<EtaLabel etaSeconds={720} />);
    expect(screen.getByText("12 min")).toBeInTheDocument();
    expect(document.querySelector('[data-testid="eta-range"]')).toBeNull();
  });

  it("flag-on renders a bounded range", () => {
    setFeatureOverride("predictiveEtaV2", true);
    render(<EtaLabel etaSeconds={720} />);
    const el = screen.getByTestId("eta-range");
    expect(el.textContent).toContain("–");
    expect(el).toHaveClass("eta-range");
  });

  it("flag-on gives degraded estimates a distinct style", () => {
    setFeatureOverride("predictiveEtaV2", true);
    render(<EtaLabel etaSeconds={720} degraded />);
    expect(screen.getByTestId("eta-range")).toHaveClass("eta-degraded");
  });

  it("shows a visible notice only for degraded estimates", () => {
    setFeatureOverride("predictiveEtaV2", true);
    const { rerender } = render(<DegradedEtaNotice etaSeconds={720} />);
    expect(screen.queryByTestId("eta-degraded-notice")).toBeNull();
    rerender(<DegradedEtaNotice etaSeconds={720} degraded />);
    expect(screen.getByTestId("eta-degraded-notice")).toHaveTextContent(
      /Offline estimate/,
    );
  });

  it("hides the notice when the flag is off", () => {
    render(<DegradedEtaNotice etaSeconds={720} degraded />);
    expect(screen.queryByTestId("eta-degraded-notice")).toBeNull();
  });
});
