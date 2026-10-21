import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "url";

// Build pipeline egress detector. Offline tests: canned tcpdump /
// iptables LOG lines are fed through the classifier, no capture or network.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "monitor-build-egress.sh");

function run(args, opts = {}) {
  return spawnSync("bash", [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, EGRESS_ALLOWLIST: "", EGRESS_ALLOWLIST_FILE: "" },
    ...opts,
  });
}

function classify(lines, extra = []) {
  const logDir = mkdtempSync(path.join(tmpdir(), "helphone-egress-"));
  const input = path.join(logDir, "capture.log");
  writeFileSync(input, lines.join("\n") + "\n");
  const result = run(["--classify", "--log-dir", logDir, ...extra, input]);
  const audit = path.join(logDir, "egress-audit.log");
  const summary = path.join(logDir, "egress-summary.log");
  return {
    ...result,
    audit: existsSync(audit) ? readFileSync(audit, "utf8") : "",
    summary: existsSync(summary) ? readFileSync(summary, "utf8") : "",
    logDir,
  };
}

const PRIVATE_FLOW =
  "12:00:00.000000 IP 172.17.0.2.51234 > 10.0.0.5.443: Flags [S], seq 1, win 64240, length 0";
const EXTERNAL_FLOW =
  "12:00:01.000000 IP 172.17.0.2.51235 > 203.0.113.9.443: Flags [S], seq 2, win 64240, length 0";
const METADATA_FLOW =
  "12:00:04.000000 IP 172.17.0.2.51236 > 169.254.169.254.80: Flags [S], seq 3, win 64240, length 0";
const DNS_ALLOWED =
  "12:00:02.000000 IP 10.0.0.5.5353 > 8.8.8.8.53: 12345+ A? registry.npmjs.org. (32)";
const DNS_EXFIL =
  "12:00:03.000000 IP 10.0.0.5.5354 > 8.8.8.8.53: 12346+ A? exfil.attacker.example. (28)";
const IPTABLES_DENY =
  "[  123.456] EGRESS-DENY: IN= OUT=eth0 SRC=172.17.0.2 DST=198.51.100.4 LEN=60 PROTO=TCP SPT=44321 DPT=8443";

describe("monitor-build-egress.sh script contract", () => {
  it("exists and is a hardened bash script", () => {
    expect(existsSync(SCRIPT)).toBe(true);
    const body = readFileSync(SCRIPT, "utf8");
    expect(body).toContain("#!/usr/bin/env bash");
    expect(body).toContain("set -euo pipefail");
    expect(body).toContain("EGRESS-DENY:");
  });

  it("prints usage and exits 0 on --help", () => {
    const r = run(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("monitor-build-egress.sh");
    expect(r.stdout).toContain("--classify");
    expect(r.stdout).toContain("--strict");
  });

  it("rejects unknown options with exit code 2", () => {
    expect(run(["--bogus"]).status).toBe(2);
  });
});

describe("destination extraction", () => {
  it("reads the tcpdump destination address", () => {
    const r = classify([EXTERNAL_FLOW]);
    expect(r.stdout).toContain("dst=203.0.113.9");
    expect(r.audit).toContain("dst=203.0.113.9");
  });

  it("reads the destination from an iptables LOG line", () => {
    const r = classify([IPTABLES_DENY]);
    expect(r.stdout).toContain("dst=198.51.100.4");
    expect(r.status).toBe(1);
  });

  it("parses IPv6 tcpdump destinations", () => {
    const r = classify([
      "12:00:06.000000 IP6 2001:db8::10.40000 > 2001:4860:4860::8888.53: 9999+ A? registry.npmjs.org. (32)",
    ]);
    expect(r.audit).toContain("dst=2001:4860:4860::8888");
  });
});

describe("unauthorized connection gate", () => {
  it("allows loopback and RFC1918 destinations", () => {
    const r = classify([PRIVATE_FLOW]);
    expect(r.status).toBe(0);
    expect(r.audit).toContain("verdict=ALLOWED");
    expect(r.audit).toContain("reason=ip-allowlist");
    expect(r.summary).toContain("verdict: PASS");
  });

  it("blocks connections to an unapproved external IP", () => {
    const r = classify([EXTERNAL_FLOW]);
    expect(r.status).toBe(1);
    expect(r.audit).toContain("verdict=UNAUTHORIZED");
    expect(r.audit).toContain("reason=ip-not-allowlisted");
    expect(r.summary).toContain("verdict: FAIL");
    expect(r.summary).toContain("unauthorized: 1");
  });

  it("allows DNS for allowlisted package registries", () => {
    const r = classify([DNS_ALLOWED]);
    expect(r.status).toBe(0);
    expect(r.audit).toContain("verdict=ALLOWED");
    expect(r.audit).toContain("domain=registry.npmjs.org");
  });

  it("blocks DNS lookups for non-allowlisted hosts", () => {
    const r = classify([DNS_EXFIL]);
    expect(r.status).toBe(1);
    expect(r.audit).toContain("reason=domain-not-allowlisted");
    expect(r.audit).toContain("domain=exfil.attacker.example");
  });

  it("never allows the cloud metadata endpoint", () => {
    const r = classify([METADATA_FLOW]);
    expect(r.status).toBe(1);
    expect(r.audit).toContain("reason=metadata-endpoint");
  });

  it("honours --report-only by auditing without failing", () => {
    const r = classify([EXTERNAL_FLOW], ["--report-only"]);
    expect(r.status).toBe(0);
    expect(r.summary).toContain("verdict: PASS");
    expect(r.audit).toContain("verdict=UNAUTHORIZED");
  });
});

describe("allowlist extension", () => {
  it("promotes an external IP to allowed via --allowlist-file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "egress-allow-"));
    const file = path.join(dir, "allowlist.txt");
    writeFileSync(file, "# partner CDN\n203.0.113.0/24\n");
    const blocked = classify([EXTERNAL_FLOW]);
    const allowed = classify([EXTERNAL_FLOW], ["--allowlist-file", file]);
    expect(blocked.status).toBe(1);
    expect(allowed.status).toBe(0);
    expect(allowed.audit).toContain("verdict=ALLOWED");
    expect(allowed.summary).toMatch(/allowlist: cidr=\d+ domain=\d+/);
  });

  it("fails on an unreadable allowlist file", () => {
    const r = classify([PRIVATE_FLOW], ["--allowlist-file", "/nonexistent/allowlist.txt"]);
    expect(r.status).not.toBe(0);
  });
});

describe("build wrapper", () => {
  it("propagates a successful build exit code when egress is clean", () => {
    const logDir = mkdtempSync(path.join(tmpdir(), "egress-wrap-"));
    const r = run(["--backend", "none", "--log-dir", logDir, "--", "true"]);
    expect(r.status).toBe(0);
    expect(existsSync(path.join(logDir, "egress-summary.log"))).toBe(true);
    expect(readFileSync(path.join(logDir, "egress-summary.log"), "utf8")).toContain("verdict: PASS");
  }, 20000);

  it("propagates a failing build exit code", () => {
    const logDir = mkdtempSync(path.join(tmpdir(), "egress-wrap-"));
    expect(run(["--backend", "none", "--log-dir", logDir, "--", "false"]).status).toBe(1);
  }, 20000);

  it("blocks the build when --strict requires capture that is unavailable", () => {
    const logDir = mkdtempSync(path.join(tmpdir(), "egress-strict-"));
    const r = run(["--strict", "--backend", "none", "--log-dir", logDir, "--", "true"]);
    expect(r.status).toBe(1);
    expect(readFileSync(path.join(logDir, "egress-summary.log"), "utf8")).toContain("capture: unavailable");
  }, 20000);

  it("defaults to monitoring npm run build when no command is given", () => {
    const body = readFileSync(SCRIPT, "utf8");
    expect(body).toContain("CMD=( npm run build )");
  });
});

describe("cidr matching", () => {
  const probe = (expr) =>
    spawnSync("bash", ["-c", `source "${SCRIPT}"; ${expr}`], { encoding: "utf8" });

  it("matches addresses inside a prefix and rejects those outside", () => {
    expect(probe('cidr_contains 10.0.0.0/8 10.1.2.3 && echo yes').stdout.trim()).toBe("yes");
    expect(probe('cidr_contains 10.0.0.0/8 11.1.2.3 && echo yes').stdout.trim()).toBe("");
    expect(probe('cidr_contains 172.16.0.0/12 172.31.255.255 && echo yes').stdout.trim()).toBe("yes");
    expect(probe('cidr_contains 172.16.0.0/12 172.32.0.0 && echo yes').stdout.trim()).toBe("");
  });

  it("handles non-octal-looking octets without octal parsing", () => {
    expect(probe("ip2int 192.168.0.10").stdout.trim()).toBe(
      String(192 * 2 ** 24 + 168 * 2 ** 16 + 10),
    );
  });
});
