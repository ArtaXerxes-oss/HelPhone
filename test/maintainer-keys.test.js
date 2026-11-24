import { describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseKeys,
  revocationOf,
  evaluateSignatureTime,
  webOfTrust,
  verifyDetached,
  checkPinnedKey,
  splitCommit,
  splitTag,
  KeyStore,
  verifyKeyCustody,
  verifyCodeownersSignOff,
} from "../scripts/security/verify_maintainer_keys.js";
import {
  parseBusFactorLedger,
  generateRefreshChecklist,
  validateRefreshState,
} from "../scripts/security/codeowners_refresh.js";

// #619 — Maintainer key revocation & web-of-trust engine. Fixtures in
// test/fixtures/pgp were generated with GnuPG 2.4 from throwaway keys
// (private halves discarded):
//   alice  Ed25519, trusted root; certifies carol
//   bob    RSA-2048; signed artifact.txt, then revoked as COMPROMISED
//   carol  Ed25519, certified by alice (web of trust)
//   dave   Ed25519, revoked as SUPERSEDED

const fx = (f) => readFileSync(join(__dirname, "fixtures/pgp", f), "utf8");
const FPR = {
  alice: "9D4C59193D279D587A6A4CF5155C9E705E2054F4",
  bob: "A3A7025E6D7C0969980AAA0FE9C5C961F24FE8A9",
  carol: "4C35958AF3760C6127ED3BC892BD9161AE2430C9",
  dave: "9EB3A37AEE8805D07FCD7E1668AA70BE65E7B831",
};
const [alice] = parseKeys(fx("alice.asc"));
const [bob] = parseKeys(fx("bob.asc"));
const [bobRevoked] = parseKeys(fx("bob-revoked-compromised.asc"));
const [carol] = parseKeys(fx("carol-certified.asc"));
const [dave] = parseKeys(fx("dave-revoked-superseded.asc"));
const artifact = readFileSync(join(__dirname, "fixtures/pgp/artifact.txt"));

describe("RFC 4880 key parsing", () => {
  it("computes v4 fingerprints and key ids for RSA and Ed25519 keys", () => {
    expect(alice.fingerprint).toBe(FPR.alice);
    expect(bob.fingerprint).toBe(FPR.bob);
    expect(bob.keyId).toBe(FPR.bob.slice(-16));
    expect(alice.algo).toBe(22);
    expect(bob.algo).toBe(1);
    expect(carol.uids[0].text).toBe("Carol Maintainer <carol@example.test>");
  });

  it("merges copies of one key served by several keyservers", () => {
    const merged = parseKeys(fx("bob.asc") + "\n" + fx("bob-revoked-compromised.asc"));
    expect(merged).toHaveLength(1);
    expect(revocationOf(merged[0])).not.toBeNull();
  });
});

describe("revocation certificates (KRL)", () => {
  it("reads a cryptographically verified 'key compromised' revocation", () => {
    expect(revocationOf(bob)).toBeNull();
    const rev = revocationOf(bobRevoked);
    expect(rev).toMatchObject({ code: 2, reason: "key compromised", text: "private key leaked", verified: true });
  });

  it("reads a 'key superseded' revocation", () => {
    expect(revocationOf(dave)).toMatchObject({ code: 1, reason: "key superseded", verified: true });
  });

  it("ignores a forged revocation that does not verify", () => {
    const forged = parseKeys(fx("bob-revoked-compromised.asc"))[0];
    forged.revocations.forEach((r) => (r.verified = false));
    expect(revocationOf(forged)).toBeNull();
  });
});

describe("evaluateSignatureTime", () => {
  const at = 1_000_000;
  it("compromise invalidates signatures made BEFORE the revocation", () => {
    const res = evaluateSignatureTime({ time: at, code: 2, reason: "key compromised", text: "" }, at - 86_400);
    expect(res.valid).toBe(false);
    expect(res.reason).toMatch(/every signature by it is invalid/);
  });

  it("'no reason' is treated like compromise", () => {
    expect(evaluateSignatureTime({ time: at, code: 0, reason: "no reason specified" }, at - 1).valid).toBe(false);
  });

  it("superseded/retired keys keep earlier signatures valid", () => {
    const rev = revocationOf(dave);
    expect(evaluateSignatureTime(rev, rev.time - 60)).toMatchObject({ valid: true });
    expect(evaluateSignatureTime(rev, rev.time + 60).valid).toBe(false);
  });
});

describe("web of trust", () => {
  it("trusts roots directly and keys certified by a root", () => {
    expect(webOfTrust(alice, [alice])).toMatchObject({ trusted: true, root: true });
    expect(webOfTrust(carol, [alice])).toMatchObject({ trusted: true, certifiers: [FPR.alice] });
  });

  it("does not trust uncertified keys or honour a raised threshold", () => {
    expect(webOfTrust(bob, [alice]).trusted).toBe(false);
    expect(webOfTrust(carol, [alice], 2).trusted).toBe(false);
  });

  it("drops certifications made by a compromised root", () => {
    expect(webOfTrust(carol, [bobRevoked]).trusted).toBe(false);
  });
});

describe("verifyDetached (release artifacts, commits, tags)", () => {
  const sig = fx("artifact.txt.asc");

  it("accepts a good signature by a trusted, unrevoked key", () => {
    const res = verifyDetached({ data: artifact, signature: sig, keys: [bob], trustedKeys: [bob], label: "a" });
    expect(res.status).toBe("ok");
    expect(res.signer).toBe(FPR.bob);
  });

  it("fails a release signed BEFORE its key was revoked as compromised", () => {
    const res = verifyDetached({ data: artifact, signature: sig, keys: [bobRevoked], trustedKeys: [bobRevoked], label: "a" });
    expect(res.status).toBe("fail");
    expect(res.detail).toMatch(/key compromised/);
    expect(res.signedAt).toBeLessThan(revocationOf(bobRevoked).time);
  });

  it("detects tampering", () => {
    const res = verifyDetached({ data: Buffer.from("tampered"), signature: sig, keys: [bob], trustedKeys: [bob], label: "a" });
    expect(res.status).toBe("fail");
    expect(res.detail).toMatch(/BAD signature/);
  });

  it("reports unknown signers and good-but-untrusted signatures", () => {
    expect(verifyDetached({ data: artifact, signature: sig, keys: [alice], label: "a" }).status).toBe("unknown");
    expect(verifyDetached({ data: artifact, signature: sig, keys: [bob], trustedKeys: [alice], label: "a" }).status).toBe("untrusted");
  });
});

describe("checkPinnedKey", () => {
  const dep = { name: "example-lib" };
  it("fails on compromise, warns on supersession, passes otherwise", () => {
    expect(checkPinnedKey(dep, FPR.bob, [bobRevoked]).status).toBe("fail");
    expect(checkPinnedKey(dep, FPR.dave, [dave]).status).toBe("warn");
    expect(checkPinnedKey(dep, FPR.alice, [alice]).status).toBe("ok");
    expect(checkPinnedKey(dep, FPR.carol, []).status).toBe("unknown");
  });
});

describe("git object splitting", () => {
  it("strips the gpgsig header (and continuation lines) from the signed payload", () => {
    const raw = Buffer.from(
      "tree abc\nparent def\nauthor A <a@x> 1 +0000\ncommitter A <a@x> 1 +0000\n" +
        "gpgsig -----BEGIN PGP SIGNATURE-----\n \n wsBc\n -----END PGP SIGNATURE-----\n\nmessage\n",
    );
    const { payload, signature } = splitCommit(raw);
    expect(payload.toString()).toBe("tree abc\nparent def\nauthor A <a@x> 1 +0000\ncommitter A <a@x> 1 +0000\n\nmessage\n");
    expect(signature).toBe("-----BEGIN PGP SIGNATURE-----\n\nwsBc\n-----END PGP SIGNATURE-----\n");
    expect(splitCommit(Buffer.from("tree abc\n\nmsg\n")).signature).toBeNull();
  });

  it("splits a signed annotated tag at the signature", () => {
    const { payload, signature } = splitTag(Buffer.from("object abc\ntag v1\n\nrelease\n-----BEGIN PGP SIGNATURE-----\nx\n"));
    expect(payload.toString()).toBe("object abc\ntag v1\n\nrelease\n");
    expect(signature.startsWith("-----BEGIN PGP SIGNATURE-----")).toBe(true);
  });
});

describe("KeyStore cache", () => {
  it("serves cached keys offline and refetches from keyservers when stale", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "keys-"));
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      return { ok: true, text: async () => fx("dave-revoked-superseded.asc") };
    };
    const store = new KeyStore({ cacheDir, keyservers: ["https://keys.openpgp.org", "https://keyserver.ubuntu.com"], fetchImpl });
    const [k] = await store.keys([FPR.dave]);
    expect(k.fingerprint).toBe(FPR.dave);
    expect(calls).toEqual([
      `https://keys.openpgp.org/vks/v1/by-fingerprint/${FPR.dave}`,
      `https://keyserver.ubuntu.com/pks/lookup?op=get&options=mr&search=0x${FPR.dave}`,
    ]);
    expect(existsSync(join(cacheDir, `${FPR.dave}.asc`))).toBe(true);

    await store.keys([FPR.dave]); // fresh cache: no network
    expect(calls).toHaveLength(2);

    const offline = new KeyStore({ cacheDir, offline: true, fetchImpl });
    expect((await offline.keys([FPR.dave]))[0].fingerprint).toBe(FPR.dave);
    expect(calls).toHaveLength(2);

    const refresh = new KeyStore({ cacheDir, refresh: true, keyservers: ["https://keys.openpgp.org"], fetchImpl });
    await refresh.keys([FPR.dave]);
    expect(calls).toHaveLength(3);
  });
});

describe("Maintainer-key ceremony & CODEOWNERS refresh (#953)", () => {
  const config = JSON.parse(readFileSync(join(__dirname, "../config/maintainer-keys.json"), "utf8"));
  const codeowners = readFileSync(join(__dirname, "../.github/CODEOWNERS"), "utf8");
  const ledger = readFileSync(join(__dirname, "../docs/bus-factor-ledger.md"), "utf8");
  const fixedNow = new Date("2026-11-21T12:00:00Z");

  it("verifies 2-of-N key custody and fails on expired or incomplete key sets", () => {
    expect(verifyKeyCustody(config, { now: fixedNow }).ok).toBe(true);

    const expired = structuredClone(config);
    expired.ceremony.custodians[0].expiresAt = "2026-01-01T00:00:00Z";
    expect(verifyKeyCustody(expired, { now: fixedNow }).ok).toBe(false);

    const incomplete = structuredClone(config);
    incomplete.ceremony.custodians = incomplete.ceremony.custodians.slice(0, 1);
    expect(verifyKeyCustody(incomplete, { now: fixedNow }).ok).toBe(false);
  });

  it("gates high-stakes paths on up-to-date CODEOWNERS sign-off", () => {
    expect(verifyCodeownersSignOff(config, codeowners, { now: fixedNow }).ok).toBe(true);

    const stale = structuredClone(config);
    stale.codeownersSignOff.expiresAt = "2026-01-01T00:00:00Z";
    expect(verifyCodeownersSignOff(stale, codeowners, { now: fixedNow }).ok).toBe(false);
  });

  it("extracts bus-factor-1 subsystems with dated drills and validates refresh checklist", () => {
    const subsystems = parseBusFactorLedger(ledger);
    const bf1 = subsystems.filter((s) => s.busFactor === 1);
    expect(bf1.length).toBeGreaterThanOrEqual(4);
    for (const s of bf1) {
      expect(s.targetDate).toBeTruthy();
      expect(s.drill).toBeTruthy();
    }

    const checklist = generateRefreshChecklist({ subsystems, config, codeownersText: codeowners });
    const validation = validateRefreshState({
      subsystems,
      config,
      codeownersText: codeowners,
      checklistText: checklist,
      now: fixedNow,
    });
    expect(validation.ok).toBe(true);
  });
});
