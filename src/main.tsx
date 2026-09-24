import React, { Suspense, lazy } from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { WalletProvider } from "./contexts/WalletContext";
import { i18nReady } from "./i18n";
import ErrorBoundary from "./components/ErrorBoundary";
import App from "./App";
import "./App.css";
import "./styles/theme.css";

// Heavy routes (Mapbox GL, ZK/WASM prover, Stellar RPC) are code-split so they
// are only fetched when the user actually navigates to them, keeping the
// initial bundle and Time-To-Interactive low.
const Help = lazy(() => import("./pages/Help"));
const Ranking = lazy(() => import("./pages/Ranking"));
// #608 spike: WebGPU spatial-clustering prototype + benchmark harness (ADR-008).
const ClusterLab = lazy(() => import("./components/WebGPUMap"));

function RouteFallback() {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
        color: "#234B4E",
        fontFamily: "system-ui, sans-serif",
        fontSize: "0.95rem",
      }}
    >
      Loading…
    </div>
  );
}

function render() {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <ErrorBoundary>
        {/*
          WalletProvider wraps the entire app so that any page can access
          wallet state via useWallet() without prop-drilling.
          StellarWalletsKit.init() is called inside WalletProvider's useEffect,
          replacing the previous global side-effect at module load time.
        */}
        <WalletProvider>
          <BrowserRouter>
            <Suspense fallback={<RouteFallback />}>
              <Routes>
                <Route path="/" element={<App />} />
                <Route path="/help" element={<Help />} />
                <Route path="/ranking" element={<Ranking />} />
                <Route path="/lab/cluster-bench" element={<ClusterLab />} />
              </Routes>
            </Suspense>
          </BrowserRouter>
        </WalletProvider>
      </ErrorBoundary>
    </React.StrictMode>,
  );
}

// Wait for translation bundles to load before first render so the page
// never flashes untranslated keys.
i18nReady.then(render).catch(() => {
  // Translation load failed (e.g. offline) — render anyway with fallback keys.
  render();
});
