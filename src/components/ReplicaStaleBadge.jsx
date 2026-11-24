import { staleBadgeText } from "../lib/replicaLag.js";

/**
 * `⚠️ Stale ~Xs` badge shown while replica replay lag exceeds the 10 s budget
 * (ISP-065). Renders nothing when data is fresh. The text is announced politely
 * to screen readers, and the badge carries the explanation in its title.
 */
export function ReplicaStaleBadge({ lagMs }) {
  const text = staleBadgeText(lagMs);
  if (!text) return null;
  return (
    <span
      role="status"
      aria-live="polite"
      data-testid="replica-stale-badge"
      title="Server history is behind the latest ledger. Newest activity may be missing."
      style={{
        display: "inline-flex",
        alignItems: "center",
        fontSize: "11px",
        color: "#FF7A6B",
        marginBottom: "10px",
        marginLeft: "10px",
      }}
    >
      {text}
    </span>
  );
}
