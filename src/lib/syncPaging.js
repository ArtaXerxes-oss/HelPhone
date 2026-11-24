/**
 * Paging rules for the delta stream (#930).
 *
 * Shared by the sync server route, the server tests and the hydration budget
 * gate, so all three agree on page boundaries. Plain JS with no Node or DOM
 * imports.
 */

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Canonical paging order: counter first, then actor, then instance. Ordering by
 * counter makes every page a global prefix of the delta stream, so the vector a
 * page returns never skips an operation that was not sent.
 */
export function compareForPaging(a, b) {
  return (
    a.counter - b.counter ||
    compareText(a.actor, b.actor) ||
    compareText(a.instance ?? "", b.instance ?? "")
  );
}

/**
 * Takes at most `limit` operations from a list sorted by `compareForPaging`.
 * A cut never splits a run of equal counters, so operations that tie on counter
 * across instances land in the same page and the page vector cannot skip any
 * of them. A page that is a single tied run takes the whole run.
 */
export function cutPage(sorted, limit) {
  if (sorted.length <= limit) return sorted;
  let end = limit;
  const boundary = sorted[end - 1].counter;
  if (sorted[end].counter !== boundary) return sorted.slice(0, end);
  while (end > 0 && sorted[end - 1].counter === boundary) end--;
  if (end > 0) return sorted.slice(0, end);
  while (end < sorted.length && sorted[end].counter === boundary) end++;
  return sorted.slice(0, end);
}
