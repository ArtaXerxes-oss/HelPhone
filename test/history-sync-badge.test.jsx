// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import HistorySyncBadge from "../src/components/HistorySyncBadge.jsx";

describe("HistorySyncBadge (#932)", () => {
  it("announces hydration progress as a polite live status", () => {
    render(<HistorySyncBadge progress={{ phase: "deltas", percent: 60 }} />);
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toContain("Syncing history 60%");
  });

  it("clamps the percentage to the 0–100 range", () => {
    render(<HistorySyncBadge progress={{ phase: "deltas", percent: 150 }} />);
    expect(screen.getByRole("status").textContent).toContain("Syncing history 100%");
  });

  it("renders nothing once hydration has completed", () => {
    const { container } = render(<HistorySyncBadge progress={{ phase: "complete", percent: 100 }} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing before any progress event has arrived", () => {
    const { container } = render(<HistorySyncBadge progress={null} />);
    expect(container.innerHTML).toBe("");
  });
});
