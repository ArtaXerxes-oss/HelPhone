import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import OfflineRoutePanel from "../src/features/help/OfflineRoutePanel.jsx";

function fakeRouter({ zones = [{ zone: "lagos-island", name: "Lagos Island" }], load, route } = {}) {
  return {
    listZones: vi.fn(async () => zones),
    loadZone: vi.fn(
      load ||
        (async (zone) => ({
          zone,
          version: 2,
          nodeCount: 1234,
          destinations: [{ name: "Stadium shelter", kind: "shelter", lat: 6.45, lng: 3.4 }],
        })),
    ),
    route: vi.fn(route || (async () => ({ reachable: true, durationS: 420, cost: 420, pathLengthM: 2300 }))),
    dispose: vi.fn(),
  };
}

describe("OfflineRoutePanel (#893)", () => {
  it("says when no offline road data is installed", async () => {
    const router = fakeRouter({ zones: [] });
    render(<OfflineRoutePanel location={[6.44, 3.39]} createRouter={() => router} />);
    expect(await screen.findByText(/No offline road data is installed/)).toBeInTheDocument();
  });

  it("loads a zone and routes from the selected location to a destination", async () => {
    const router = fakeRouter();
    render(<OfflineRoutePanel location={[6.44, 3.39]} createRouter={() => router} />);

    fireEvent.click(await screen.findByRole("button", { name: "Save for offline use" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Road data v2 ready offline"));
    expect(router.loadZone).toHaveBeenCalledWith("lagos-island");

    fireEvent.click(screen.getByRole("button", { name: "Route from my location" }));
    await waitFor(() => expect(screen.getByTestId("offline-route-summary")).toHaveTextContent("About 7 min to Stadium shelter · 2.3 km of road"));
    expect(router.route).toHaveBeenCalledWith([6.44, 3.39], [6.45, 3.4]);
  });

  it("reports a stale tile kept after a failed integrity check", async () => {
    const router = fakeRouter({
      load: async (zone) => ({ zone, version: 1, nodeCount: 10, destinations: [], stale: true }),
    });
    render(<OfflineRoutePanel location={null} createRouter={() => router} />);
    fireEvent.click(await screen.findByRole("button", { name: "Save for offline use" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Using saved road data v1: the latest download failed its integrity check."),
    );
  });

  it("disables routing until a location is set", async () => {
    const router = fakeRouter();
    render(<OfflineRoutePanel location={null} createRouter={() => router} />);
    fireEvent.click(await screen.findByRole("button", { name: "Save for offline use" }));
    await screen.findByText(/Set your location above/);
    expect(screen.getByRole("button", { name: "Route from my location" })).toBeDisabled();
  });

  it("disposes the router on unmount", async () => {
    const router = fakeRouter();
    const { unmount } = render(<OfflineRoutePanel location={null} createRouter={() => router} />);
    await screen.findByRole("button", { name: "Save for offline use" });
    unmount();
    expect(router.dispose).toHaveBeenCalled();
  });
});
