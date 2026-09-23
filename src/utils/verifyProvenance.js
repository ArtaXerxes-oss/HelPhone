// Client-side check that the bundle this page is running matches what the
// SLSA provenance workflow (.github/workflows/slsa-provenance.yml) built, signed
// and logged in the Rekor transparency log.
//
// Note: checks digests + Rekor inclusion of the signed digest manifest; the
// Fulcio certificate / signature itself is verified by `cosign verify-blob` in
// CI. Add sigstore-js here if the browser must verify the signature too.

const REKOR_URL = "https://rekor.sigstore.dev/api/v1/log/entries";

export async function sha256Hex(data) {
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Parse `sha256sum` output into { path: hex }. */
export function parseDigests(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([0-9a-f]{64}) [ *](.+)$/);
    if (m) out[m[2]] = m[1];
  }
  return out;
}

/** Pull the sha256 artifact hash out of a Rekor hashedrekord log entry. */
export function rekorArtifactHash(entryResponse) {
  const entry = Object.values(entryResponse || {})[0];
  if (!entry?.body) return null;
  const body = JSON.parse(atob(entry.body));
  return body?.spec?.data?.hash?.value ?? null;
}

/**
 * @returns {Promise<{ status: 'verified' | 'unverified', reason?: string, commit?: string }>}
 */
export async function verifyProvenance({
  fetchImpl = fetch,
  doc = document,
} = {}) {
  try {
    const [provRes, digestsRes] = await Promise.all([
      fetchImpl("/provenance.json", { cache: "no-store" }),
      fetchImpl("/digests.txt", { cache: "no-store" }),
    ]);
    if (!provRes.ok || !digestsRes.ok)
      return { status: "unverified", reason: "no provenance published" };
    const provenance = await provRes.json();
    const digestsBytes = await digestsRes.arrayBuffer();
    const digests = parseDigests(new TextDecoder().decode(digestsBytes));

    // 1. The entry bundle actually executing matches the signed manifest.
    const src = doc
      .querySelector('script[type="module"][src]')
      ?.getAttribute("src");
    if (!src) return { status: "unverified", reason: "entry script not found" };
    const path = new URL(src, location.href).pathname.replace(/^\//, "");
    const scriptRes = await fetchImpl("/" + path);
    if (!scriptRes.ok)
      return { status: "unverified", reason: "entry script not fetchable" };
    if (digests[path] !== (await sha256Hex(await scriptRes.arrayBuffer()))) {
      return { status: "unverified", reason: "entry bundle digest mismatch" };
    }

    // 2. That manifest is the one logged in Rekor by the CI signing step.
    if (!Number.isInteger(provenance.rekorLogIndex))
      return { status: "unverified", reason: "missing Rekor log index" };
    const rekorRes = await fetchImpl(
      `${REKOR_URL}?logIndex=${provenance.rekorLogIndex}`,
    );
    if (!rekorRes.ok)
      return { status: "unverified", reason: "Rekor entry not found" };
    if (
      rekorArtifactHash(await rekorRes.json()) !==
      (await sha256Hex(digestsBytes))
    ) {
      return {
        status: "unverified",
        reason: "Rekor entry does not match digest manifest",
      };
    }

    return { status: "verified", commit: provenance.commit };
  } catch (err) {
    return {
      status: "unverified",
      reason: err?.message || "verification failed",
    };
  }
}
