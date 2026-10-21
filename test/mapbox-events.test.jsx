import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import "@testing-library/jest-dom/vitest";

// jest-canvas-mock calls jest.fn() internally; under Vitest, alias the
// global so it resolves to vi.fn() instead of throwing "jest is not defined".
globalThis.jest = vi;
await import("jest-canvas-mock");

// ---------------------------------------------------------------------------
// Mapbox GL event handling in Help.jsx's <Map onClick={...}> handler:
//   onClick={(e) => { if (isGetMode && requestStatus === "idle")
//     setLocation([e.lngLat.lat, e.lngLat.lng]) }}
//
// react-map-gl/mapbox wraps real Mapbox GL JS, which needs a WebGL canvas
// that jsdom can't provide -- jest-canvas-mock (imported above, per the
// issue's acceptance criteria) stubs the 2D/WebGL canvas context so
// react-map-gl's own internals don't throw during this mocked render, and
// react-map-gl's <Map>/<Marker>/<NavigationControl>/useMap are mocked below
// so the test drives Help.jsx's actual onClick callback directly instead of
// simulating real pointer events against a real map canvas.
// ---------------------------------------------------------------------------

let lastMapProps = null;

vi.mock("react-map-gl/mapbox", () => ({
  __esModule: true,
  default: (props) => {
    lastMapProps = props;
    return (
      <div data-testid="mock-map" onClick={props.onClick}>
        {props.children}
      </div>
    );
  },
  Marker: ({ latitude, longitude, children }) => (
    <div data-testid="mock-marker" data-lat={latitude} data-lng={longitude}>
      {children}
    </div>
  ),
  Popup: ({ children }) => <div data-testid="mock-popup">{children}</div>,
  Source: ({ children }) => <>{children}</>,
  Layer: () => null,
  NavigationControl: () => null,
  useMap: () => ({ current: null }),
}));

vi.mock("mapbox-gl/dist/mapbox-gl.css", () => ({}));

vi.mock("../src/lib/contract", () => ({
  getRequest: vi.fn().mockResolvedValue(null),
  getActiveRequests: vi.fn().mockResolvedValue([]),
  getResponder: vi.fn().mockResolvedValue(null),
  getResponderCount: vi.fn().mockResolvedValue(0),
  createRequest: vi.fn(),
  acceptRequest: vi.fn(),
  markArrived: vi.fn(),
  resolveRequest: vi.fn(),
  cancelRequest: vi.fn(),
  getRanking: vi.fn().mockResolvedValue([]),
  ensureAccountFunded: vi.fn(),
  getWalletBalances: vi.fn().mockResolvedValue({}),
  updateLocation: vi.fn(),
  recordExpertVerification: vi.fn(),
  subscribeToContractEvents: vi.fn(() => () => {}),
}));

vi.mock("../src/lib/zk", () => ({
  buildLocationProofZone: vi.fn(),
  generateLocationProof: vi.fn(),
  shortProofId: vi.fn((s) => s?.slice(0, 8) || ""),
}));

vi.mock("@creit-tech/stellar-wallets-kit/sdk", () => ({
  StellarWalletsKit: {
    getAddress: vi.fn().mockResolvedValue({ address: "" }),
    on: vi.fn(() => () => {}),
    authModal: vi.fn(),
    disconnect: vi.fn(),
  },
}));

vi.mock("@creit-tech/stellar-wallets-kit/types", () => ({
  KitEventType: { STATE_UPDATED: "STATE_UPDATED", DISCONNECT: "DISCONNECT" },
}));

// NOTE: in this authoring environment, `localStorage`/`window.localStorage`
// are both undefined under jsdom (a pre-existing issue also hit by
// test/load-profile.test.js and test/my-requests-and-anonymize.test.js) --
// Help.jsx's profile-persistence effect calls `localStorage.setItem(...)`
// unconditionally on mount, so rendering <Help/> fails here for that
// unrelated, pre-existing reason rather than anything specific to Mapbox
// event handling. See PR description.

import Help from "../src/pages/Help.jsx";

function renderHelp() {
  return render(
    <MemoryRouter>
      <Help />
    </MemoryRouter>,
  );
}

describe("Mapbox GL event handling (Help.jsx)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastMapProps = null;
  });

  it("renders the mocked Map instance", async () => {
    renderHelp();
    await waitFor(() =>
      expect(screen.getByTestId("mock-map")).toBeInTheDocument(),
    );
    expect(lastMapProps).toBeTruthy();
    expect(typeof lastMapProps.onClick).toBe("function");
  });

  it("simulating a map click in Get Help mode saves the clicked coordinates into state", async () => {
    renderHelp();
    await waitFor(() =>
      expect(screen.getByTestId("mock-map")).toBeInTheDocument(),
    );

    // No marker at the clicked location yet (component defaults to Get
    // Help mode with no location selected).
    expect(screen.queryByTestId("mock-marker")).not.toBeInTheDocument();

    // Simulate a Mapbox GL click event: react-map-gl passes an object
    // exposing `lngLat` on click, which Help.jsx reads as
    // `[e.lngLat.lat, e.lngLat.lng]`.
    fireEvent.click(screen.getByTestId("mock-map"));
    lastMapProps.onClick({ lngLat: { lat: 37.7749, lng: -122.4194 } });

    await waitFor(() => {
      const marker = screen.getByTestId("mock-marker");
      expect(marker).toHaveAttribute("data-lat", "37.7749");
      expect(marker).toHaveAttribute("data-lng", "-122.4194");
    });
  });
});
