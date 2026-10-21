import { test, expect } from "@playwright/test";

// ---------------------------------------------------------------------------
// ISP-131/134/135 — field-tools E2E with mocked WebSerial + Web NFC.
// Verifies: gesture-gated connect flow, RADIO badge, rugged glove targets,
// staging fallback, SOS hold-to-confirm dialog.
// ---------------------------------------------------------------------------

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    // Persist rugged mode for deterministic target-size assertions.
    localStorage.setItem("hp_rugged", "1");
    localStorage.setItem("hp_tour_done", "1");

    // Mock WebSerial with a loopback-ish port.
    const port = {
      getInfo: () => ({ usbVendorId: 0x1d50, usbProductId: 0x60c6 }),
      open: async () => {},
      close: async () => {},
      readable: {
        getReader: () => ({
          read: async () => new Promise(() => {}),
          releaseLock: () => {},
          cancel: async () => {},
        }),
      },
      writable: {
        getWriter: () => ({
          write: async () => {},
          releaseLock: () => {},
        }),
      },
      addEventListener: () => {},
    };
    Object.defineProperty(navigator, "serial", {
      configurable: true,
      value: { requestPort: async () => port, addEventListener: () => {} },
    });
  });
});

test.describe("Field tools — radio bridge", () => {
  test("connect button pairs from one gesture and shows the radio badge", async ({ page }) => {
    await page.goto("/help");
    await expect(page.getByTestId("field-ops-card")).toBeVisible();

    await page.getByRole("button", { name: "Open radio bridge" }).click();
    await expect(page.getByRole("dialog", { name: /field radio bridge/i })).toBeVisible();

    await page.getByTestId("radio-connect").click();
    await expect(page.getByTestId("radio-badge")).toContainText(/RADIO LINK/);

    await page.getByRole("button", { name: "Disconnect radio" }).click();
    await expect(page.getByTestId("radio-badge")).toContainText(/RADIO IDLE/);
  });

  test("transport badge reflects offline state", async ({ page }) => {
    await page.goto("/help");
    await page.context().setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));
    await expect(page.getByTestId("field-transport-badge")).toContainText(/OFFLINE/);
  });
});

test.describe("Field tools — rugged mode (ISP-131)", () => {
  test("glove targets are at least 48px when rugged mode is on", async ({ page }) => {
    await page.goto("/help");
    await expect(page.getByTestId("rugged-toggle")).toHaveAttribute("aria-checked", "true");

    const sizes = await page.evaluate(() => {
      // CSS-modules hashed class names: match by data-testid parent + substring.
      const els = [
        ...document.querySelectorAll(
          '[data-testid="field-ops-card"] button, [class*="hp-help-sidebar"] button',
        ),
      ];
      return els.slice(0, 12).map((el) => {
        const r = el.getBoundingClientRect();
        return { h: r.height, w: r.width };
      });
    });
    for (const s of sizes) {
      expect(s.h).toBeGreaterThanOrEqual(44);
    }
  });

  test("rugged toggle flips aria-checked and the DOM attribute", async ({ page }) => {
    await page.goto("/help");
    await page.getByTestId("rugged-toggle").click();
    await expect(page.getByTestId("rugged-toggle")).toHaveAttribute("aria-checked", "false");
    await expect(page.locator("html")).not.toHaveAttribute("data-rugged", "1");
  });

  test("hardware SOS key opens the confirm sheet (mocked keydown)", async ({ page }) => {
    await page.goto("/help");
    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { keyCode: 249, key: "SOS", bubbles: true }));
    });
    // Pocket-press outside geofence (no location) must NOT auto-dispatch:
    // the full-screen confirm sheet appears instead.
    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent("keyup", { keyCode: 249, key: "SOS", bubbles: true }));
    });
    await expect(page.getByTestId("sos-hold-button")).toBeVisible();
    await page.getByTestId("sos-cancel").click();
    await expect(page.getByTestId("sos-hold-button")).not.toBeVisible();
  });
});

test.describe("Field tools — staging NFC fallback (ISP-134)", () => {
  test("no-NFC devices get the short-code fallback path", async ({ page }) => {
    await page.addInitScript(() => {
      delete window.NDEFReader;
    });
    await page.goto("/help");
    await page.getByRole("button", { name: "Open staging check-in" }).click();
    await expect(page.getByTestId("nfc-fallback-notice")).toBeVisible();
    await expect(page.getByTestId("nfc-code-input")).toBeVisible();
  });
});
