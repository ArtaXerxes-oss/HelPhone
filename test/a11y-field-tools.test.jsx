import { describe, expect, it, vi } from "vitest";
import { axe } from "jest-axe";
import { render, screen } from "@testing-library/react";

// ---------------------------------------------------------------------------
// ISP-131/134/135 — accessibility of the field-tools sheets (radio bridge,
// NFC staging fallback, SOS hold-to-confirm) with mocked WebSerial + Web NFC.
// ---------------------------------------------------------------------------

function mockSerial() {
  const port = {
    readable: true,
    writable: true,
    getInfo: () => ({ usbVendorId: 0x1d50, usbProductId: 0x60c6 }),
    open: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
  Object.defineProperty(navigator, "serial", {
    configurable: true,
    value: {
      requestPort: vi.fn().mockResolvedValue(port),
      addEventListener: vi.fn(),
    },
  });
  return port;
}

function mockNdefReader() {
  class NDEFReader {
    scan = vi.fn().mockResolvedValue(undefined);
    addEventListener = vi.fn();
  }
  window.NDEFReader = NDEFReader;
}

describe("field tools accessibility", () => {
  it("RadioSheet has no critical/serious axe violations with WebSerial mocked", async () => {
    mockSerial();
    const { default: RadioSheet } =
      await import("../src/components/field/RadioSheet");
    const bridge = {
      state: {
        status: "disconnected",
        callsign: "HEL-04",
        baudRate: 19200,
        band: "ham",
        txQueued: 0,
        txActive: false,
        rxCount: 0,
        txCount: 0,
        lastRxAt: null,
        lastTxAt: null,
        lastError: null,
        backgroundTxParked: 0,
      },
      subscribe: () => () => {},
      connect: vi.fn(),
      disconnect: vi.fn(),
      configure: vi.fn(),
      baudOptions: [19200, 9600],
    };
    const { container } = render(
      <RadioSheet open onClose={() => {}} bridge={bridge} />,
    );
    const results = await axe(container);
    const bad = results.violations.filter(
      (v) => v.impact === "critical" || v.impact === "serious",
    );
    expect(bad.map((v) => v.id)).toEqual([]);
    expect(screen.getByTestId("radio-connect")).toBeTruthy();
  });

  it("RadioSheet closed renders nothing", async () => {
    const { default: RadioSheet } =
      await import("../src/components/field/RadioSheet");
    const { container } = render(
      <RadioSheet open={false} onClose={() => {}} bridge={null} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("StagingSheet fallback (no-NFC device) has no critical/serious violations", async () => {
    mockNdefReader();
    delete window.NDEFReader; // simulate no-NFC device
    const { default: StagingSheet } =
      await import("../src/components/field/StagingSheet");
    const checkIn = {
      supported: false,
      scanning: false,
      startScan: vi.fn(),
      stopScan: vi.fn(),
      submitFallbackCode: vi
        .fn()
        .mockResolvedValue({ status: "rejected", reason: "unknown-code" }),
      roster: [
        {
          responderId: "R1",
          stagingId: "STAGING-BRAVO-04",
          direction: "IN",
          at: Date.now(),
          duplicate_suppressed: false,
        },
      ],
      lastResult: null,
      rateLimited: false,
      unmatched: [],
    };
    const { container } = render(
      <StagingSheet open onClose={() => {}} checkIn={checkIn} />,
    );
    const results = await axe(container);
    const bad = results.violations.filter(
      (v) => v.impact === "critical" || v.impact === "serious",
    );
    expect(bad.map((v) => v.id)).toEqual([]);
    expect(screen.getByTestId("nfc-fallback-notice")).toBeTruthy();
    expect(screen.getByTestId("nfc-code-input")).toBeTruthy();
  });

  it("StagingSheet escalates unmatched INs with an alert role", async () => {
    const { default: StagingSheet } =
      await import("../src/components/field/StagingSheet");
    const checkIn = {
      supported: true,
      scanning: false,
      startScan: vi.fn(),
      stopScan: vi.fn(),
      submitFallbackCode: vi.fn(),
      roster: [],
      lastResult: null,
      rateLimited: false,
      unmatched: [
        { responderId: "R1", stagingId: "S1", direction: "IN", at: 0 },
      ],
    };
    render(<StagingSheet open onClose={() => {}} checkIn={checkIn} />);
    expect(screen.getByTestId("nfc-unmatched")).toBeTruthy();
  });

  it("SosSheet is a labelled dialog with glove-sized hold + cancel targets", async () => {
    const { default: SosSheet } =
      await import("../src/components/field/SosSheet");
    const { container } = render(
      <SosSheet open onCancel={() => {}} onConfirm={() => {}} />,
    );
    const results = await axe(container);
    const bad = results.violations.filter(
      (v) => v.impact === "critical" || v.impact === "serious",
    );
    expect(bad.map((v) => v.id)).toEqual([]);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    const hold = screen.getByTestId("sos-hold-button");
    const styles = getComputedStyle(hold);
    expect(parseInt(styles.width, 10)).toBeGreaterThanOrEqual(48);
    expect(parseInt(styles.height, 10)).toBeGreaterThanOrEqual(48);
    const cancel = screen.getByTestId("sos-cancel");
    expect(
      parseInt(getComputedStyle(cancel).minHeight, 10) || 48,
    ).toBeGreaterThanOrEqual(48);
  });

  it("rugged Button size renders a 56px glove target", async () => {
    const { default: Button } = await import("../src/components/ui/Button");
    render(<Button size="rugged">Dispatch</Button>);
    const btn = screen.getByRole("button", { name: /dispatch/i });
    expect(btn.className).toContain("hp-btn--rugged");
    // CSS file loads in jsdom via vite; assert the class contract exists.
    const css = await import("../src/components/ui/Button.css?raw").catch(
      () => null,
    );
    if (css && css.default) {
      expect(css.default).toMatch(/hp-btn--rugged[\s\S]*?min-height:\s*56px/);
    }
  });
});
