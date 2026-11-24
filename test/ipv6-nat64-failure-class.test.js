import { describe, expect, it } from "vitest";
import {
  classifyProbeFailure,
  createNetworkEstimator,
  isIpv4LiteralHost,
  probeEndpoint,
} from "../src/lib/networkEstimator.ts";

const LITERAL = "http://203.0.113.10:8000";
const HOSTNAME = "https://soroban-testnet.stellar.org";

const healthy = () => ({ ok: true, status: 200, json: async () => ({ result: { status: "healthy" } }) });

describe("IPv6-only / NAT64 failure class (#928)", () => {
  it("recognises dotted-quad hosts only", () => {
    expect(isIpv4LiteralHost("203.0.113.10")).toBe(true);
    expect(isIpv4LiteralHost("0.0.0.0")).toBe(true);
    expect(isIpv4LiteralHost("256.1.1.1")).toBe(false);
    expect(isIpv4LiteralHost("soroban-testnet.stellar.org")).toBe(false);
  });

  it("buckets an IPv4 literal that fails at the network layer as ipv6-nat64", () => {
    expect(classifyProbeFailure(LITERAL, { error: "websocket error" })).toBe("ipv6-nat64");
  });

  it("buckets any endpoint that reports an unreachable address family as ipv6-nat64", () => {
    expect(classifyProbeFailure(HOSTNAME, { error: "connect ENETUNREACH 2001:db8::1:443" })).toBe("ipv6-nat64");
    expect(classifyProbeFailure(HOSTNAME, { error: "connect EHOSTUNREACH" })).toBe("ipv6-nat64");
  });

  it("keeps ordinary hostname failures in the generic network bucket", () => {
    expect(classifyProbeFailure(HOSTNAME, { error: "Failed to fetch" })).toBe("network");
  });

  it("keeps timeouts, HTTP errors and unhealthy nodes in their own buckets", () => {
    expect(classifyProbeFailure(LITERAL, { aborted: true })).toBe("timeout");
    expect(classifyProbeFailure(HOSTNAME, { status: 503 })).toBe("http");
    expect(classifyProbeFailure(HOSTNAME, { error: "node not healthy" })).toBe("unhealthy");
  });

  it("tags a probe that fails on an IPv4 literal", async () => {
    const fetchImpl = async () => {
      throw new Error("connect EHOSTUNREACH 203.0.113.10:8000");
    };
    const result = await probeEndpoint(LITERAL, { fetchImpl, timeoutMs: 1000 });
    expect(result).toMatchObject({ ok: false, failureClass: "ipv6-nat64" });
  });

  it("reports the class on the endpoint and fails over to the hostname backup", async () => {
    const fetchImpl = async (url) => {
      if (url.startsWith(LITERAL)) throw new Error("connect EHOSTUNREACH");
      return healthy();
    };
    const est = createNetworkEstimator({
      endpoints: [LITERAL, HOSTNAME],
      fetchImpl,
      failureThreshold: 1,
      now: () => 1000,
    });
    const snap = await est.probeAll();
    expect(snap.endpoints[0]).toMatchObject({ primary: true, healthy: false, failureClass: "ipv6-nat64" });
    expect(snap.endpoints[0].label).toBe("203.0.113.10");
    expect(snap.activeLabel).toBe("soroban-testnet.stellar.org");
    expect(snap.endpoints[1].failureClass).toBeNull();
  });
});
