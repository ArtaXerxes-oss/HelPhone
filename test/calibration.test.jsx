/** ADR-022 calibration recorder and dashboard tests. */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import "@testing-library/jest-dom/vitest";
import {
  appendCalibrationRecord,
  clearCalibrationRecords,
  exportCalibrationDataset,
  loadCalibrationRecords,
  recordEtaOutcome,
  redactArea,
  summarizeByMode,
} from "../src/lib/calibration.ts";
import { estimateEta } from "../src/lib/etaEstimate.ts";
import CalibrationDashboard from "../src/pages/CalibrationDashboard.tsx";

beforeEach(() => clearCalibrationRecords());
afterEach(() => {
  clearCalibrationRecords();
  cleanup();
});

const outcome = (overrides = {}) =>
  recordEtaOutcome({
    displayed: {
      min: 10,
      max: 16,
      confidence: 0.9,
      degraded: false,
      label: "10–16 min",
    },
    etaRealizedSeconds: 780,
    lat: 6.5244,
    lng: 3.3792,
    ...overrides,
  });

describe("redaction", () => {
  it("buckets coordinates to 0.1 degrees", () => {
    expect(redactArea(6.5244, 3.3792)).toBe("6.5,3.4");
    expect(redactArea(-1.23, 36.81)).toBe("-1.2,36.8");
  });

  it("uses unknown for missing coordinates", () => {
    expect(redactArea(null, null)).toBe("unknown");
    expect(redactArea(NaN, 3)).toBe("unknown");
  });

  it("exported dataset contains no exact coordinates or identifiers", () => {
    const exported = exportCalibrationDataset([outcome()]);
    const text = JSON.stringify(exported);
    expect(text).not.toContain("6.5244");
    expect(text).not.toContain("3.3792");
    expect(text).not.toMatch(/wallet|requestId|address/i);
    expect(exported[0]).toHaveProperty("eta_realized");
    expect(exported[0]).toHaveProperty("area", "6.5,3.4");
  });
});

describe("recordEtaOutcome", () => {
  it("records the displayed range and realized ETA", () => {
    expect(outcome()).toMatchObject({
      displayedMin: 10,
      displayedMax: 16,
      etaRealizedSeconds: 780,
      mode: "traffic",
    });
  });

  it("computes error against the range midpoint", () => {
    // midpoint 13 min, realized 13 min -> zero error
    expect(outcome().errorSeconds).toBe(0);
    expect(outcome({ etaRealizedSeconds: 960 }).errorSeconds).toBe(180);
  });

  it("flags whether the realized arrival was inside the range", () => {
    expect(outcome().withinRange).toBe(true);
    expect(outcome({ etaRealizedSeconds: 1500 }).withinRange).toBe(false);
  });

  it("infers offline mode from a degraded estimate", () => {
    const displayed = estimateEta({ etaSeconds: 900, trafficAware: false });
    expect(recordEtaOutcome({ displayed, etaRealizedSeconds: 900 }).mode).toBe(
      "offline",
    );
  });
});

describe("storage and aggregation", () => {
  it("appends and loads records", () => {
    appendCalibrationRecord(outcome());
    expect(loadCalibrationRecords()).toHaveLength(1);
  });

  it("summarises by mode", () => {
    const rows = [
      recordEtaOutcome({
        displayed: {
          min: 10,
          max: 16,
          confidence: 0.9,
          degraded: false,
          label: "",
        },
        etaRealizedSeconds: 780,
        mode: "traffic",
      }),
      recordEtaOutcome({
        displayed: {
          min: 10,
          max: 16,
          confidence: 0.9,
          degraded: false,
          label: "",
        },
        etaRealizedSeconds: 900,
        mode: "traffic",
      }),
      recordEtaOutcome({
        displayed: {
          min: 10,
          max: 22,
          confidence: 0.45,
          degraded: true,
          label: "",
        },
        etaRealizedSeconds: 900,
        mode: "offline",
      }),
    ];
    const summary = summarizeByMode(rows);
    expect(summary.find((s) => s.mode === "traffic")).toMatchObject({
      count: 2,
      coveragePct: 100,
    });
    expect(summary.find((s) => s.mode === "offline")).toMatchObject({
      count: 1,
      coveragePct: 100,
    });
    expect(summary.find((s) => s.mode === "fallback")).toMatchObject({
      count: 0,
    });
  });

  it("returns an empty dashboard-safe summary for no data", () => {
    expect(
      summarizeByMode([]).every((s) => s.count === 0 && s.coveragePct === 0),
    ).toBe(true);
  });
});

describe("dashboard", () => {
  it("renders committed dataset summaries by mode", () => {
    render(
      <MemoryRouter>
        <CalibrationDashboard />
      </MemoryRouter>,
    );
    expect(
      screen.getByRole("heading", { name: "ETA calibration" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("summary-traffic")).toHaveTextContent(/traffic/);
    expect(screen.getByTestId("summary-offline")).toHaveTextContent(/offline/);
    expect(screen.getByTestId("summary-fallback")).toHaveTextContent(
      /fallback/,
    );
  });

  it("shows that runtime constants match the committed fit", () => {
    render(
      <MemoryRouter>
        <CalibrationDashboard />
      </MemoryRouter>,
    );
    expect(screen.getByText("yes")).toBeInTheDocument();
  });
});
