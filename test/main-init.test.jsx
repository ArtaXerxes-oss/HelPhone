import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import React from "react";

// ---------------------------------------------------------------------------
// src/main.tsx is the app entry point: it mounts the app tree into #root via
// ReactDOM.createRoot once the i18n bundles have loaded. StellarWalletsKit is
// no longer initialised as a module-level side effect here — WalletProvider
// (src/contexts/WalletContext.tsx) owns that, inside its mount effect.
//
// main.tsx runs as top-level module code, so the only way to observe it is to
// mock the modules it touches and import it fresh in each test. createRoot is
// wrapped rather than replaced: the calls are recorded *and* the tree really
// mounts, so the provider's effect (and therefore the kit init) actually runs.
// ---------------------------------------------------------------------------

// Tell React this is an act()-aware environment so effects flush inside act().
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const renderMock = vi.fn();
const createRootMock = vi.fn();
const initMock = vi.fn();

vi.mock("react-dom/client", async (importOriginal) => {
  const actual = await importOriginal();
  createRootMock.mockImplementation((container, options) => {
    const root = actual.createRoot(container, options);
    renderMock.mockImplementation((element) => root.render(element));
    return { ...root, render: renderMock };
  });
  return {
    default: { createRoot: createRootMock },
    createRoot: createRootMock,
  };
});

vi.mock("@creit-tech/stellar-wallets-kit/sdk", () => ({
  StellarWalletsKit: {
    init: initMock,
    getAddress: vi.fn(async () => ({ address: "" })),
    // on() returns its own unsubscribe function.
    on: vi.fn(() => vi.fn()),
    authModal: vi.fn(async () => ({ address: "" })),
    disconnect: vi.fn(async () => {}),
  },
}));

vi.mock("@creit-tech/stellar-wallets-kit/types", () => ({
  Networks: { TESTNET: "TESTNET" },
  SwkAppDarkTheme: {},
  KitEventType: {
    STATE_UPDATED: "state-updated",
    DISCONNECT: "disconnect",
  },
}));

vi.mock("@creit-tech/stellar-wallets-kit/modules/utils", () => ({
  defaultModules: vi.fn(() => [
    { productId: "freighter", productIcon: undefined },
    { productId: "unknown-wallet", productIcon: undefined },
  ]),
}));

vi.mock("../src/App.tsx", () => ({ default: () => null }));
vi.mock("../src/pages/Help.tsx", () => ({ default: () => null }));
vi.mock("../src/pages/Ranking.tsx", () => ({ default: () => null }));
vi.mock("../src/App.css", () => ({}));
vi.mock("../src/styles/theme.css", () => ({}));
vi.mock("../src/i18n", () => ({ i18nReady: Promise.resolve() }));
vi.mock("../src/components/ErrorBoundary.tsx", () => ({
  default: ({ children }) => children,
}));

async function loadMain() {
  vi.resetModules();
  let mod;
  // main.tsx renders from `i18nReady.then(...)`, so the mount happens in a
  // microtask after the import resolves — flush both inside act() so React
  // effects (including WalletProvider's kit init) have run on return.
  await act(async () => {
    mod = await import("../src/main.tsx");
  });
  return mod;
}

describe("App initialization (main.jsx)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '<div id="root"></div>';
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("mounts without crashing when #root exists", async () => {
    await expect(loadMain()).resolves.toBeDefined();
  });

  it("calls ReactDOM.createRoot against the #root element", async () => {
    await loadMain();
    expect(createRootMock).toHaveBeenCalledTimes(1);
    expect(createRootMock).toHaveBeenCalledWith(
      document.getElementById("root"),
    );
  });

  it("instantiates the Router and Providers by rendering into the root", async () => {
    await loadMain();
    expect(renderMock).toHaveBeenCalledTimes(1);
    const rendered = renderMock.mock.calls[0][0];
    // The rendered tree is <StrictMode><ErrorBoundary><WalletProvider><BrowserRouter>… —
    // assert the top of the tree is StrictMode wrapping a single child,
    // confirming main.tsx wired the router/providers rather than rendering a bare element.
    expect(rendered.type).toBe(React.StrictMode);
    expect(rendered.props.children).toBeTruthy();
  });

  it("calls global initializers (StellarWalletsKit.init) exactly once on mount", async () => {
    await loadMain();
    expect(createRootMock).toHaveBeenCalled();
    // The kit is initialised by WalletProvider's mount effect, which sits above
    // the router — so it is ready before any route content can use the wallet.
    // StrictMode double-invokes render but not the effect body's init guard, so
    // a single init call is the contract.
    expect(initMock).toHaveBeenCalledTimes(1);
    const renderOrder = renderMock.mock.invocationCallOrder[0];
    const initOrder = initMock.mock.invocationCallOrder[0];
    expect(initOrder).toBeGreaterThan(renderOrder);
  });

  it("configures StellarWalletsKit with network and theme (global styles/config applied)", async () => {
    await loadMain();
    const initArg = initMock.mock.calls[0][0];
    expect(initArg).toMatchObject({
      network: "TESTNET",
      theme: expect.objectContaining({
        background: "#1c2c24",
        primary: "#7357FF",
      }),
      authModal: expect.objectContaining({ showInstallLabel: true }),
    });
    expect(Array.isArray(initArg.modules)).toBe(true);
  });
});
