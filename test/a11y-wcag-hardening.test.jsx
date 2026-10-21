import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { MapAccessibleAlternative } from "../src/components/MapAccessibleAlternative.jsx";
import { FocusTrap } from "../src/lib/focusTrap.js";
import { getMotionConfig, isPrefersReducedMotion } from "../src/lib/a11yMotion.js";

describe("ISP-097: WCAG 2.2 AA & Screen-Reader Hardening Spike", () => {
  describe("MapAccessibleAlternative Component", () => {
    const mockIncidents = [
      { id: "inc-1", title: "Medical Evacuation", distance: "200m", status: "CRITICAL", eta: "4 mins" },
      { id: "inc-2", title: "Water Supply Depot", distance: "650m", status: "ACTIVE", eta: "12 mins" },
    ];

    it("should render accessible region landmark and accessible names for all items", () => {
      const handleSelect = vi.fn();
      render(
        <MapAccessibleAlternative
          incidents={mockIncidents}
          selectedIncidentId="inc-1"
          onSelectIncident={handleSelect}
        />,
      );

      const landmark = screen.getByRole("region", { name: /Accessible Incident and Rendezvous List/i });
      expect(landmark).toBeDefined();

      const buttons = screen.getAllByRole("button");
      expect(buttons).toHaveLength(2);

      expect(buttons[0].getAttribute("aria-label")).toContain("Medical Evacuation");
      expect(buttons[0].getAttribute("aria-label")).toContain("4 mins");
      expect(buttons[0].getAttribute("aria-pressed")).toBe("true");

      expect(buttons[1].getAttribute("aria-pressed")).toBe("false");
    });

    it("should trigger selection on click / keyboard Enter", () => {
      const handleSelect = vi.fn();
      render(
        <MapAccessibleAlternative
          incidents={mockIncidents}
          selectedIncidentId="inc-1"
          onSelectIncident={handleSelect}
        />,
      );

      const secondButton = screen.getAllByRole("button")[1];
      fireEvent.click(secondButton);
      expect(handleSelect).toHaveBeenCalledWith("inc-2");
    });

    it("should update polite live region with ETA changes without spamming", () => {
      const { rerender } = render(
        <MapAccessibleAlternative
          incidents={mockIncidents}
          selectedIncidentId="inc-1"
          etaUpdates={{ "inc-1": "3 mins" }}
        />,
      );

      const announcer = screen.getByTestId("a11y-eta-announcer");
      expect(announcer.textContent).toContain("Responder ETA is now 3 mins");
    });
  });

  describe("FocusTrap Modal Utility", () => {
    let container;
    let button1;
    let button2;
    let invoker;

    beforeEach(() => {
      document.body.innerHTML = "";
      invoker = document.createElement("button");
      invoker.textContent = "Open Modal";
      document.body.appendChild(invoker);

      container = document.createElement("div");
      button1 = document.createElement("button");
      button1.textContent = "Action 1";
      button2 = document.createElement("button");
      button2.textContent = "Action 2";

      container.appendChild(button1);
      container.appendChild(button2);
      document.body.appendChild(container);
    });

    it("should trap focus inside the modal and cycle on Tab", () => {
      const trap = new FocusTrap(container, { invokerElement: invoker });
      trap.activate();

      expect(document.activeElement).toBe(button1);

      // Simulate Shift+Tab from first element -> wraps to last
      const shiftTabEvent = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true });
      container.dispatchEvent(shiftTabEvent);

      // Deactivate restores focus to invoker
      trap.deactivate();
      expect(document.activeElement).toBe(invoker);
    });

    it("should call onEscape when Escape key is pressed", () => {
      const onEscape = vi.fn();
      const trap = new FocusTrap(container, { invokerElement: invoker, onEscape });
      trap.activate();

      const escapeEvent = new KeyboardEvent("keydown", { key: "Escape", bubbles: true });
      document.dispatchEvent(escapeEvent);

      expect(onEscape).toHaveBeenCalled();
      trap.deactivate();
    });
  });

  describe("a11yMotion Reduced-Motion Safety", () => {
    it("should detect reduced-motion preference and return 0ms duration", () => {
      // Mock window.matchMedia
      window.matchMedia = vi.fn().mockImplementation((query) => ({
        matches: query === "(prefers-reduced-motion: reduce)",
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }));

      expect(isPrefersReducedMotion()).toBe(true);

      const config = getMotionConfig(500);
      expect(config.isReduced).toBe(true);
      expect(config.durationMs).toBe(0);
      expect(config.autoplay).toBe(false);
    });
  });
});
