import { useEffect, useMemo, useRef, useState } from "react";
import { createOfflineRouter } from "../../lib/offlineRouting.js";

/**
 * Offline evacuation routing on /help (#893).
 *
 * Lists the routing zones installed under /routing-tiles, loads one into the
 * routing worker (verified and cached for offline use), and routes from the
 * page's selected location to the zone's named destinations (shelters,
 * hospitals, assembly points) with no network.
 */
export default function OfflineRoutePanel({ location, createRouter = createOfflineRouter }) {
  const router = useMemo(() => createRouter(), [createRouter]);
  const [zones, setZones] = useState(null);
  const [zone, setZone] = useState("");
  const [loaded, setLoaded] = useState(null);
  const [destination, setDestination] = useState("");
  const [route, setRoute] = useState(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    router.listZones().then((list) => {
      if (!mounted.current) return;
      setZones(list);
      if (list.length) setZone(list[0].zone);
    });
    return () => {
      mounted.current = false;
      router.dispose();
    };
  }, [router]);

  const loadZone = async () => {
    if (!zone) return;
    setBusy(true);
    setRoute(null);
    setStatus("Loading offline road data…");
    try {
      const info = await router.loadZone(zone);
      if (!mounted.current) return;
      setLoaded(info);
      setDestination(info.destinations.length ? "0" : "");
      setStatus(
        info.stale
          ? `Using saved road data v${info.version}: the latest download failed its integrity check.`
          : `Road data v${info.version} ready offline (${info.nodeCount.toLocaleString()} intersections).`,
      );
    } catch (err) {
      if (mounted.current) setStatus(`Offline road data unavailable: ${err.message}`);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const findRoute = async () => {
    const target = loaded && loaded.destinations[Number(destination)];
    if (!location || !target) return;
    setBusy(true);
    setStatus("Finding a route…");
    try {
      const r = await router.route(location, [target.lat, target.lng]);
      if (!mounted.current) return;
      setRoute({ ...r, target });
      setStatus(r.reachable ? `Route to ${target.name} found.` : `No road route to ${target.name} in this zone.`);
    } catch (err) {
      if (mounted.current) setStatus(`Routing failed: ${err.message}`);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const buttonStyle = {
    background: "#3F8487",
    color: "#ECE0CC",
    border: "none",
    padding: "0.55rem 0.9rem",
    borderRadius: "0.5rem",
    cursor: "pointer",
    fontWeight: "bold",
  };

  return (
    <section
      aria-labelledby="offline-route-heading"
      style={{ marginTop: "1.5rem", padding: "1rem", background: "#1c2c24", borderRadius: "0.75rem" }}
    >
      <h3 id="offline-route-heading" style={{ margin: "0 0 0.5rem" }}>
        Offline evacuation route
      </h3>
      {zones === null ? (
        <p style={{ color: "#a2a586", margin: 0 }}>Checking for offline road data…</p>
      ) : zones.length === 0 ? (
        <p style={{ color: "#a2a586", margin: 0 }}>No offline road data is installed for any zone yet.</p>
      ) : (
        <>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
            <label htmlFor="offline-route-zone">Zone</label>
            <select id="offline-route-zone" value={zone} onChange={(e) => setZone(e.target.value)} disabled={busy}>
              {zones.map((z) => (
                <option key={z.zone} value={z.zone}>
                  {z.name || z.zone}
                </option>
              ))}
            </select>
            <button type="button" onClick={loadZone} disabled={busy || !zone} style={buttonStyle}>
              Save for offline use
            </button>
          </div>
          {loaded && (
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center", marginTop: "0.75rem" }}>
              <label htmlFor="offline-route-destination">Go to</label>
              <select
                id="offline-route-destination"
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
                disabled={busy || !loaded.destinations.length}
              >
                {loaded.destinations.map((d, i) => (
                  <option key={`${d.kind}-${d.name}-${i}`} value={String(i)}>
                    {d.name} ({d.kind.replace("-", " ")})
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={findRoute}
                disabled={busy || !location || destination === ""}
                style={buttonStyle}
              >
                Route from my location
              </button>
            </div>
          )}
          {loaded && !location && (
            <p style={{ color: "#a2a586", fontSize: "0.85rem" }}>Set your location above to route from it.</p>
          )}
        </>
      )}
      <p role="status" aria-live="polite" style={{ fontSize: "0.9rem", margin: "0.6rem 0 0" }}>
        {status}
      </p>
      {route && route.reachable && (
        <p data-testid="offline-route-summary" style={{ margin: "0.35rem 0 0" }}>
          {route.durationS !== null
            ? `About ${Math.max(1, Math.round(route.durationS / 60))} min`
            : `${(route.cost / 1000).toFixed(1)} km`}{" "}
          to {route.target.name}
          {route.pathLengthM ? ` · ${(route.pathLengthM / 1000).toFixed(1)} km of road` : ""}
        </p>
      )}
    </section>
  );
}
