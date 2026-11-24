/**
 * One map pin per responder DID (#922).
 *
 * The responder poll reads one contract slot per accepted responder, and a
 * single DID can occupy more than one slot (or be re-read under a new slot id)
 * after a clone or a re-accept. Keying pins by slot id then stacks several
 * markers on top of one person. This keys them by DID instead, so the map
 * shows one marker per person.
 */

export interface ResponderLike {
  id?: string | number;
  responder?: string | null;
  lat?: number | null;
  lng?: number | null;
}

export interface ResponderPin {
  /** Stable per DID, so the clusterer and the canvas overlay do not churn. */
  id: string;
  did: string;
  lat: number;
  lng: number;
  kind: "enroute" | "resolved";
}

function normalizeDid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toUpperCase();
  return trimmed.length > 0 ? trimmed : null;
}

function isFiniteCoord(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Collapse responder records to one pin per DID. A later record for the same
 * DID replaces an earlier one, matching the poll's update rule, so the newest
 * read wins for position. Records without a DID cannot be attributed and keep
 * their own pin keyed by slot id, which preserves the previous behaviour for
 * them. Records without finite coordinates are not drawn.
 */
export function collapseResponderPins(
  responders: ReadonlyArray<ResponderLike | null | undefined>,
  { arrived = false }: { arrived?: boolean } = {},
): ResponderPin[] {
  const byKey = new Map<string, ResponderPin>();
  responders.forEach((record, index) => {
    if (!record || !isFiniteCoord(record.lat) || !isFiniteCoord(record.lng)) return;
    const did = normalizeDid(record.responder);
    const key = did ?? `slot:${String(record.id ?? index)}`;
    byKey.delete(key); // re-insert so Map order follows the newest record
    byKey.set(key, {
      id: `resp-${did ?? String(record.id ?? index)}`,
      did: did ?? "",
      lat: record.lat,
      lng: record.lng,
      kind: arrived ? "resolved" : "enroute",
    });
  });
  return [...byKey.values()];
}
