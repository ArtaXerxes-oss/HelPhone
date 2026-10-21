// #625 license policy, shared by the CLI gate (license_compliance.js) and the
// supply-chain security API (#600, server/routes/supplyChainSecurity.ts) so
// both classify dependencies identically.

// Approved compatibility matrix per #625 (+ trivially equivalent permissives).
export const APPROVED = new Set([
  "MIT",
  "ISC",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "MIT-0",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "Unlicense",
]);
// Strong copyleft: legal liability for open deployment models → gate fails.
export const DENIED_RE = /^(GPL|AGPL)(\W|$)/i;
// Everything else (MPL, LGPL, EPL, CC-BY-*, unknown, ...) → REVIEW warning.
export const REVIEW = "review";

// Pre-existing transitive exceptions, documented so the gate passes on the
// current tree but still catches NEW denied licenses. Remove entries as the
// underlying deps are replaced; do not extend without legal review.
export const EXCEPTIONS = {
  "node_modules/@lobstrco/signer-extension-api":
    "GPL-3.0 via stellar-wallets-kit transitive; tracked for replacement",
  "node_modules/rpc-websockets":
    "LGPL-3.0-only transitive; review on next major bump",
};

export function classify(license) {
  if (
    !license ||
    license === "SEE LICENSE IN LICENSE.md" ||
    license === "SEE LICENSE IN LICENSE.txt"
  )
    return REVIEW;
  const atoms = license
    .split(/[\s(),|/]+/)
    .filter((t) => t && !/^(OR|AND|WITH|Classpath|exception)$/i.test(t));
  if (atoms.length > 0 && atoms.every((a) => APPROVED.has(a)))
    return "approved";
  if (DENIED_RE.test(license)) return "denied";
  if (atoms.some((a) => DENIED_RE.test(a))) return "denied";
  return REVIEW;
}
