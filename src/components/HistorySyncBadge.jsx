/**
 * "Syncing history X%" badge (#932).
 *
 * Shown while history hydration is partial, so responders can see that routing
 * ETAs are held back. It is a live status region, so assistive technology
 * announces progress politely. It has no controls, so there is nothing to focus
 * and nothing to activate from the keyboard.
 *
 * Feed it the `onProgress` events from `hydratePaged`.
 */
export default function HistorySyncBadge({ progress }) {
  if (!progress || progress.phase === "complete" || progress.phase === "join_receipt") {
    return null;
  }
  const percent = Math.max(0, Math.min(100, Math.round(progress.percent ?? 0)));
  return (
    <div
      role="status"
      aria-live="polite"
      data-phase={progress.phase}
      style={{
        display: "inline-block",
        padding: "4px 10px",
        borderRadius: 6,
        background: "#234B4E",
        color: "#ECE0CC",
        fontSize: 13,
        lineHeight: 1.4,
      }}
    >
      Syncing history {percent}%. Routing ETAs are paused until it finishes.
    </div>
  );
}
