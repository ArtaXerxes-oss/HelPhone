import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import IncidentMapSyncPanel, { LOST_AFTER_MS } from "../src/features/help/IncidentMapSyncPanel.jsx";

/** In-memory BroadcastChannel shared by every panel in the test. */
function bus() {
  const ends = new Set();
  return () => {
    const end = {
      onmessage: null,
      postMessage(data) {
        for (const other of ends) if (other !== end) queueMicrotask(() => other.onmessage && other.onmessage({ data }));
      },
      close() {
        ends.delete(end);
      },
    };
    ends.add(end);
    return end;
  };
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await act(() => new Promise((r) => setTimeout(r, 0)));
};

describe("IncidentMapSyncPanel (#894)", () => {
  it("syncs responder positions between two tabs over the channel", async () => {
    const open = bus();
    render(
      <>
        <IncidentMapSyncPanel clientId="tab-a" location={[6.45, 3.39]} createChannel={open} />
        <IncidentMapSyncPanel clientId="tab-b" location={[6.46, 3.4]} createChannel={open} />
      </>,
    );
    await flush();
    const summaries = screen.getAllByText(/responders? ·/);
    for (const s of summaries) expect(s).toHaveTextContent("2 responders · 0 incidents · 2 devices on the roster");
  });

  it("offers to remove a device that has gone silent, and removes it", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const open = bus();
      let t = 1_000_000;
      const now = () => t;
      const gone = render(<IncidentMapSyncPanel clientId="gone" location={[6.45, 3.39]} createChannel={open} now={now} />);
      render(<IncidentMapSyncPanel clientId="here" location={[6.46, 3.4]} createChannel={open} now={now} />);
      await flush();
      gone.unmount(); // the other device disappears for good

      t += LOST_AFTER_MS + 1;
      await act(async () => {
        vi.advanceTimersByTime(15_000); // next gossip tick refreshes the view
      });
      fireEvent.click(await screen.findByRole("button", { name: "Remove lost device" }));
      expect(screen.getByRole("status")).toHaveTextContent("Removed device-gone from the incident roster.");
      expect(screen.getByText(/devices? on the roster/)).toHaveTextContent("1 device on the roster");
      expect(screen.queryByRole("button", { name: "Remove lost device" })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("says when the browser has no broadcast channel", () => {
    render(<IncidentMapSyncPanel clientId="x" location={null} createChannel={() => null} />);
    expect(screen.getByRole("status")).toHaveTextContent("Map sync is unavailable in this browser.");
  });
});
