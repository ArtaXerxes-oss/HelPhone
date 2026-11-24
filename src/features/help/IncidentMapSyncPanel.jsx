import { useEffect, useMemo, useRef, useState } from "react";
import { IncidentMapReplica, connectReplica } from "../../services/incidentMapSync.js";
import { getInstanceId } from "../../lib/swChannel";

export const INCIDENT_MAP_CHANNEL = "helphone-incident-map-v1";
/** A roster device silent for this long is offered for removal. */
export const LOST_AFTER_MS = 5 * 60_000;
const GOSSIP_EVERY_MS = 15_000;
const systemNow = () => Date.now();

function openChannel() {
  return typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(INCIDENT_MAP_CHANNEL) : null;
}

/**
 * Shared incident map on /help (#894): a pruned state-vector CRDT replica
 * synced by binary gossip. This device publishes its selected location as a
 * responder entry; every peer on the channel converges on the same map.
 */
export default function IncidentMapSyncPanel({
  location,
  clientId = getInstanceId(),
  createChannel = openChannel,
  now = systemNow,
}) {
  const replica = useMemo(() => new IncidentMapReplica(`device-${clientId}`, { now }), [clientId, now]);
  const linkRef = useRef(null);
  const [view, setView] = useState(() => snapshot(replica, now));
  const [status, setStatus] = useState("");

  useEffect(() => {
    const channel = createChannel();
    if (!channel) {
      setStatus("Map sync is unavailable in this browser.");
      return undefined;
    }
    const refresh = () => setView(snapshot(replica, now));
    const link = connectReplica(replica, channel, {
      onChange: refresh,
      onRefused: (id) => setStatus(`Ignored updates from removed device ${id}.`),
    });
    linkRef.current = link;
    link.sync();
    const timer = setInterval(() => {
      link.sync();
      refresh();
    }, GOSSIP_EVERY_MS);
    return () => {
      clearInterval(timer);
      link.close();
      if (typeof channel.close === "function") channel.close();
      linkRef.current = null;
    };
  }, [replica, createChannel, now]);

  useEffect(() => {
    if (!location) return;
    replica.set(`responder/${replica.clientId}`, { lat: location[0], lng: location[1], ts: now() });
    if (linkRef.current) linkRef.current.notify();
    setView(snapshot(replica, now));
  }, [location, replica, now]);

  const remove = (id) => {
    if (replica.removeFromRoster(id)) {
      setStatus(`Removed ${id} from the incident roster.`);
      if (linkRef.current) linkRef.current.notify();
      setView(snapshot(replica, now));
    }
  };

  return (
    <section
      aria-labelledby="incident-map-sync-heading"
      style={{ marginTop: "1rem", padding: "1rem", background: "#1c2c24", borderRadius: "0.75rem" }}
    >
      <h3 id="incident-map-sync-heading" style={{ margin: "0 0 0.5rem" }}>
        Shared incident map
      </h3>
      <p style={{ margin: 0, fontSize: "0.9rem" }}>
        {view.responders} responder{view.responders === 1 ? "" : "s"} · {view.incidents} incident
        {view.incidents === 1 ? "" : "s"} · {view.roster.length} device{view.roster.length === 1 ? "" : "s"} on the roster
      </p>
      <p style={{ margin: "0.25rem 0 0", fontSize: "0.8rem", color: "#a2a586" }} data-testid="incident-map-sync-stats">
        Log {view.logOps} ops · {view.deleteTombstones} pending deletes · {(view.sentBytes / 1024).toFixed(1)} KB sent
      </p>
      {view.lost.length > 0 && (
        <ul style={{ listStyle: "none", padding: 0, margin: "0.6rem 0 0" }}>
          {view.lost.map((id) => (
            <li key={id} style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginTop: "0.3rem" }}>
              <span style={{ fontSize: "0.85rem" }}>{id} has not synced for 5+ minutes</span>
              <button
                type="button"
                onClick={() => remove(id)}
                style={{ background: "#FF7A6B", color: "#1c2c24", border: "none", borderRadius: "0.4rem", padding: "0.3rem 0.6rem", cursor: "pointer" }}
              >
                Remove lost device
              </button>
            </li>
          ))}
        </ul>
      )}
      <p role="status" aria-live="polite" style={{ fontSize: "0.85rem", margin: "0.5rem 0 0" }}>
        {status}
      </p>
    </section>
  );
}

function snapshot(replica, now) {
  const entries = replica.entries();
  let responders = 0;
  let incidents = 0;
  for (const k of entries.keys()) {
    if (k.startsWith("responder/")) responders++;
    else if (k.startsWith("incident/")) incidents++;
  }
  const roster = replica.roster();
  const t = now();
  const lost = roster.filter((id) => {
    if (id === replica.clientId) return false;
    const heard = replica.lastHeard.get(id);
    return heard === undefined ? false : t - heard > LOST_AFTER_MS;
  });
  const s = replica.stats();
  return { responders, incidents, roster, lost, logOps: s.logOps, deleteTombstones: s.deleteTombstones, sentBytes: s.sentBytes };
}
