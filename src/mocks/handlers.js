import { http, HttpResponse } from "msw";

// ---------------------------------------------------------------------------
// Default network-level handlers for tests. Individual tests can override any
// of these per-case with `server.use(...)` (see src/mocks/server.js).
// ---------------------------------------------------------------------------

// ── Backend API (server/index.js) ──────────────────────────────────────────
const backendHandlers = [
  http.get("*/zk/health", () =>
    HttpResponse.json({ status: "ready", ready: true }),
  ),
  http.get("*/health", () =>
    HttpResponse.json({ status: "ready", ready: true }),
  ),

  http.post("*/zk/prove", () =>
    HttpResponse.json({
      success: true,
      proof: "00".repeat(32),
      nullifier: "1",
    }),
  ),

  http.get("*/api/ranking", () =>
    HttpResponse.json([
      {
        responder: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA3",
        total_arrivals: 3,
      },
    ]),
  ),

  http.get("*/api/preferences/:address", () =>
    HttpResponse.json({ preferences: {} }),
  ),
  http.post("*/api/preferences/:address", () =>
    HttpResponse.json({ success: true }),
  ),

  http.post("*/api/feedback", () => HttpResponse.json({ success: true })),
  http.get("*/api/feedback/:requestId", () =>
    HttpResponse.json({ feedback: [] }),
  ),
];

// ── Stellar Horizon (queried directly from src/lib/contract.js) ───────────
const horizonHandlers = [
  http.get("*/accounts/:address", ({ params }) =>
    HttpResponse.json({
      account_id: params.address,
      sequence: "1",
      balances: [{ asset_type: "native", balance: "10000.0000000" }],
    }),
  ),
];

// ── Stellar Soroban RPC (queried via @stellar/stellar-sdk's rpc.Server) ───
// Soroban RPC is JSON-RPC over a single POST endpoint, so it's matched by
// method name in the body rather than by path.
const sorobanRpcHandlers = [
  http.post("*/soroban*", async ({ request }) => {
    const body = await request.json().catch(() => ({}));
    switch (body.method) {
      case "getHealth":
        return HttpResponse.json({
          jsonrpc: "2.0",
          id: body.id,
          result: { status: "healthy" },
        });
      case "getLatestLedger":
        return HttpResponse.json({
          jsonrpc: "2.0",
          id: body.id,
          result: { id: "mock-ledger", sequence: 1, protocolVersion: 22 },
        });
      default:
        return HttpResponse.json({ jsonrpc: "2.0", id: body.id, result: {} });
    }
  }),
];

export const handlers = [
  ...backendHandlers,
  ...horizonHandlers,
  ...sorobanRpcHandlers,
];
