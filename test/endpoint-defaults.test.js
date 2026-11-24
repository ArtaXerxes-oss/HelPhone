import { describe, expect, it } from "vitest";
import { DEV_SERVER_BASE, resolveEndpoint } from "../src/lib/endpointDefaults.js";

describe("client endpoint defaults (#927)", () => {
  it("keeps the configured value when one is set, in any mode", () => {
    expect(resolveEndpoint("https://api.helphone.example", "", { isProd: true, origin: "https://app.example" })).toBe(
      "https://api.helphone.example",
    );
    expect(resolveEndpoint("  https://api.helphone.example  ", "")).toBe("https://api.helphone.example");
  });

  it("uses the local server in development when nothing is configured", () => {
    expect(resolveEndpoint(undefined, "/events/stream")).toBe(`${DEV_SERVER_BASE}/events/stream`);
    expect(resolveEndpoint("", "", { isProd: false, origin: "https://app.example" })).toBe(DEV_SERVER_BASE);
  });

  it("resolves against the deployed origin in production, never localhost", () => {
    const prod = { isProd: true, origin: "https://app.example/" };
    expect(resolveEndpoint(undefined, "/events/stream", prod)).toBe("https://app.example/events/stream");
    expect(resolveEndpoint("", "", prod)).toBe("https://app.example");
    expect(resolveEndpoint("", "", { isProd: true, origin: "" })).toBe("");
    expect(resolveEndpoint(undefined, "/events/stream", prod)).not.toContain("localhost");
  });
});
