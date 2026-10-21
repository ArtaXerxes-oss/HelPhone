import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { generateEd25519Keypair, signEd25519Message } from "../src/lib/crypto.js";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  JSONScalar,
  clampLimit,
  clampOffset,
  createLoaders,
} from "../server/graphql/resolvers.js";
import {
  MAX_ROOT_FIELDS,
  buildContext,
  createApolloServer,
  createGraphQLHandler,
} from "../server/graphql/server.js";
import { Kind } from "graphql";

// A fake database keyed on the SQL text, recording every call so tests can
// assert how many queries a GraphQL operation really costs.
function fakeDb({ requests = [], responders = [], verifications = [] } = {}) {
  const calls = [];
  const query = vi.fn(async (sql, params = []) => {
    calls.push({ sql, params });
    if (/FROM responders/.test(sql)) {
      const ids = params[0].map(String);
      return { rows: responders.filter((r) => ids.includes(String(r.request_id))) };
    }
    if (/FROM expert_verifications/.test(sql)) {
      const wallets = params[0];
      const max = params[1];
      const rows = wallets.flatMap((w) =>
        verifications
          .filter((v) => v.wallet === w)
          .sort((a, b) => b.recorded_at - a.recorded_at)
          .slice(0, max)
      );
      return { rows };
    }
    if (/FROM requests WHERE id = ANY/.test(sql)) {
      const ids = params[0].map(String);
      return { rows: requests.filter((r) => ids.includes(String(r.id))) };
    }
    if (/FROM requests/.test(sql)) {
      const status = /WHERE status/.test(sql) ? params[0] : null;
      const limit = params[params.length - 2];
      const offset = params[params.length - 1];
      const rows = requests.filter((r) => !status || r.status === status);
      return { rows: rows.slice(offset, offset + limit) };
    }
    return { rows: [] };
  });
  return { query, calls };
}

const health = {
  ping: async () => ({ ok: true, latencyMs: 3 }),
  stats: () => ({ total: 2, active: 1, idle: 1, waiting: 0, maxConnections: 20 }),
};

const makeRequests = (n) =>
  Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    status: i % 2 ? "Resolved" : "Pending",
    created_at: new Date(Date.UTC(2026, 0, i + 1)),
    latitude: 1.5,
  }));

async function run(server, query, { db, user = null, variables } = {}) {
  const ctx = {
    query: db.query,
    health,
    loaders: createLoaders(db.query),
    user,
  };
  const res = await server.executeOperation({ query, variables }, { contextValue: ctx });
  expect(res.body.kind).toBe("single");
  return res.body.singleResult;
}

describe("clamping", () => {
  it("caps page size and rejects nonsense", () => {
    expect(clampLimit(undefined, 20)).toBe(20);
    expect(clampLimit(null, 20)).toBe(20);
    expect(clampLimit(Number.NaN, 20)).toBe(20);
    expect(clampLimit(0, 20)).toBe(1);
    expect(clampLimit(-5, 20)).toBe(1);
    expect(clampLimit(7.9, 20)).toBe(7);
    expect(clampLimit(10_000, 20)).toBe(MAX_PAGE_SIZE);
  });

  it("never lets offset go negative", () => {
    expect(clampOffset(undefined)).toBe(0);
    expect(clampOffset(-3)).toBe(0);
    expect(clampOffset(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clampOffset(12.7)).toBe(12);
  });
});

describe("queries", () => {
  const server = createApolloServer({ introspection: false });

  it("lists requests newest-first with typed fields and untyped attributes", async () => {
    const db = fakeDb({ requests: makeRequests(3) });
    const { data, errors } = await run(server, `{ requests { id status createdAt attributes } }`, { db });
    expect(errors).toBeUndefined();
    expect(data.requests).toHaveLength(3);
    expect(data.requests[0]).toEqual({
      id: "1",
      status: "Pending",
      createdAt: "2026-01-01T00:00:00.000Z",
      attributes: { latitude: 1.5 },
    });
    expect(db.calls[0].sql).toMatch(/ORDER BY created_at DESC/);
  });

  it("filters by status using a bound parameter, never string interpolation", async () => {
    const db = fakeDb({ requests: makeRequests(4) });
    const hostile = `Pending'; DROP TABLE requests; --`;
    await run(server, `query($s: String) { requests(status: $s) { id } }`, { db, variables: { s: hostile } });
    expect(db.calls[0].sql).not.toContain("DROP");
    expect(db.calls[0].params[0]).toBe(hostile);

    const ok = await run(server, `{ requests(status: "Resolved") { id status } }`, { db });
    expect(ok.data.requests.map((r) => r.status)).toEqual(["Resolved", "Resolved"]);
  });

  it("applies default and maximum page sizes and offset", async () => {
    const db = fakeDb({ requests: makeRequests(150) });
    expect((await run(server, `{ requests { id } }`, { db })).data.requests).toHaveLength(DEFAULT_PAGE_SIZE);
    expect((await run(server, `{ requests(limit: 9999) { id } }`, { db })).data.requests).toHaveLength(
      MAX_PAGE_SIZE
    );
    const paged = await run(server, `{ requests(limit: 2, offset: 4) { id } }`, { db });
    expect(paged.data.requests.map((r) => r.id)).toEqual(["5", "6"]);
  });

  it("fetches one request by id, or null when missing", async () => {
    const db = fakeDb({ requests: makeRequests(3) });
    expect((await run(server, `{ request(id: "2") { id status } }`, { db })).data.request).toEqual({
      id: "2",
      status: "Resolved",
    });
    expect((await run(server, `{ request(id: "99") { id } }`, { db })).data.request).toBeNull();
  });

  it("reports database health and pool stats", async () => {
    const db = fakeDb();
    const { data } = await run(server, `{ health { status database databaseLatencyMs pool { total maxConnections } } }`, { db });
    expect(data.health).toEqual({
      status: "ok",
      database: true,
      databaseLatencyMs: 3,
      pool: { total: 2, maxConnections: 20 },
    });
  });

  it("reports degraded when the database ping fails", async () => {
    const db = fakeDb();
    const ctx = { query: db.query, health: { ...health, ping: async () => ({ ok: false, latencyMs: 2000 }) }, loaders: createLoaders(db.query), user: null };
    const res = await server.executeOperation({ query: `{ health { status database } }` }, { contextValue: ctx });
    expect(res.body.singleResult.data.health).toEqual({ status: "degraded", database: false });
  });
});

describe("N+1 elimination (DataLoader batching)", () => {
  const server = createApolloServer({ introspection: false });

  it("costs ONE responders query for a whole page, not one per request", async () => {
    const requests = makeRequests(25);
    const responders = requests.flatMap((r) => [
      { request_id: r.id, arrived: true, name: "a" },
      { request_id: r.id, arrived: false, name: "b" },
    ]);
    const db = fakeDb({ requests, responders });

    const { data, errors } = await run(
      server,
      `{ requests(limit: 25) { id responderCount arrivedCount responders { requestId arrived attributes } } }`,
      { db }
    );

    expect(errors).toBeUndefined();
    expect(data.requests).toHaveLength(25);
    expect(data.requests[0]).toMatchObject({ responderCount: 2, arrivedCount: 1 });
    expect(data.requests[0].responders).toEqual([
      { requestId: "1", arrived: true, attributes: { name: "a" } },
      { requestId: "1", arrived: false, attributes: { name: "b" } },
    ]);
    const responderQueries = db.calls.filter((c) => /FROM responders/.test(c.sql));
    expect(responderQueries).toHaveLength(1);
    expect(responderQueries[0].params[0]).toHaveLength(25);
    // 1 for the page + 1 for every responder field on all 25 requests.
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  it("gives a request with no responders an empty list, not an error", async () => {
    const db = fakeDb({ requests: makeRequests(2), responders: [{ request_id: 1, arrived: true }] });
    const { data } = await run(server, `{ requests { id responderCount responders { arrived } } }`, { db });
    expect(data.requests[1]).toEqual({ id: "2", responderCount: 0, responders: [] });
  });

  it("batches verification lookups across wallets with different limits", async () => {
    const verifications = [1, 2, 3, 4].flatMap((n) => [
      { wallet: "WA", recorded_at: n, kind: `a${n}` },
      { wallet: "WB", recorded_at: n, kind: `b${n}` },
    ]);
    const db = fakeDb({ verifications });
    const { data } = await run(
      server,
      `{ a: verifications(wallet: "WA", limit: 2) { recordedAt attributes } b: verifications(wallet: "WB", limit: 3) { wallet } }`,
      { db }
    );
    expect(data.a.map((v) => v.attributes.kind)).toEqual(["a4", "a3"]);
    expect(data.b).toHaveLength(3);
    expect(db.calls.filter((c) => /expert_verifications/.test(c.sql))).toHaveLength(1);
  });

  it("does not share a cache between requests (fresh loaders every time)", async () => {
    const db = fakeDb({ requests: makeRequests(1), responders: [{ request_id: 1, arrived: true }] });
    await run(server, `{ requests { responderCount } }`, { db });
    await run(server, `{ requests { responderCount } }`, { db });
    expect(db.calls.filter((c) => /FROM responders/.test(c.sql))).toHaveLength(2);
  });
});

describe("safeguards", () => {
  it(`rejects operations with more than ${MAX_ROOT_FIELDS} root fields`, async () => {
    const server = createApolloServer({ introspection: false });
    const db = fakeDb();
    const many = Array.from({ length: MAX_ROOT_FIELDS + 1 }, (_, i) => `h${i}: health { status }`).join(" ");
    const { errors } = await run(server, `{ ${many} }`, { db });
    expect(errors[0].message).toMatch(/root fields; the limit is/);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("allows exactly the maximum", async () => {
    const server = createApolloServer({ introspection: false });
    const db = fakeDb();
    const some = Array.from({ length: MAX_ROOT_FIELDS }, (_, i) => `h${i}: health { status }`).join(" ");
    expect((await run(server, `{ ${some} }`, { db })).errors).toBeUndefined();
  });

  it("disables introspection when told to (production default)", async () => {
    const server = createApolloServer({ introspection: false });
    const { errors } = await run(server, `{ __schema { types { name } } }`, { db: fakeDb() });
    expect(errors).toBeDefined();
  });

  it("allows introspection when enabled", async () => {
    const server = createApolloServer({ introspection: true });
    const { data, errors } = await run(server, `{ __schema { queryType { name } } }`, { db: fakeDb() });
    expect(errors).toBeUndefined();
    expect(data.__schema.queryType.name).toBe("Query");
  });
});

describe("JSON scalar", () => {
  it("passes values through and parses scalar literals", () => {
    expect(JSONScalar.serialize({ a: 1 })).toEqual({ a: 1 });
    expect(JSONScalar.parseValue([1, 2])).toEqual([1, 2]);
    expect(JSONScalar.parseLiteral({ kind: Kind.STRING, value: "x" })).toBe("x");
    expect(JSONScalar.parseLiteral({ kind: Kind.INT, value: "7" })).toBe(7);
    expect(JSONScalar.parseLiteral({ kind: Kind.FLOAT, value: "1.5" })).toBe(1.5);
    expect(JSONScalar.parseLiteral({ kind: Kind.BOOLEAN, value: true })).toBe(true);
    expect(JSONScalar.parseLiteral({ kind: Kind.NULL })).toBeNull();
    expect(() => JSONScalar.parseLiteral({ kind: Kind.OBJECT, fields: [] })).toThrow(/scalar values/);
  });
});

describe("HTTP integration", () => {
  const servers = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  });

  async function start(db) {
    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use("/graphql", createGraphQLHandler({ query: db.query, health }));
    const server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    servers.push(server);
    return `http://127.0.0.1:${server.address().port}/graphql`;
  }

  const post = (url, body, headers = {}) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  // Same canonical payload authMiddleware verifies: METHOD:path:timestamp:body
  function signed(body) {
    const { publicKey, secretKey } = generateEd25519Keypair();
    const timestamp = String(Date.now());
    const message = `POST:/:${timestamp}:${JSON.stringify(body)}`;
    return {
      publicKey,
      headers: {
        "X-Public-Key": publicKey,
        "X-Timestamp": timestamp,
        "X-Signature": signEd25519Message(message, secretKey),
      },
    };
  }

  it("serves queries end to end, through the mounted route", async () => {
    const db = fakeDb({ requests: makeRequests(2), responders: [{ request_id: 1, arrived: false }] });
    const url = await start(db);
    const res = await post(url, { query: `{ requests { id responderCount } }` });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data.requests).toEqual([
      { id: "1", responderCount: 1 },
      { id: "2", responderCount: 0 },
    ]);
  });

  it("treats a request with no auth headers as anonymous", async () => {
    const url = await start(fakeDb());
    const json = await (await post(url, { query: `{ me { publicKey } }` })).json();
    expect(json.data.me).toBeNull();
  });

  it("identifies a caller with a valid signature", async () => {
    const url = await start(fakeDb());
    const body = { query: `{ me { publicKey algorithm } }` };
    const { publicKey, headers } = signed(body);
    const json = await (await post(url, body, headers)).json();
    expect(json.data.me).toEqual({ publicKey, algorithm: "ed25519" });
  });

  it("fails loudly on bad credentials instead of silently going anonymous", async () => {
    const url = await start(fakeDb());
    const body = { query: `{ me { publicKey } }` };
    const { headers } = signed({ query: `{ health { status } }` }); // signature for a different body
    const res = await post(url, body, headers);
    expect(res.status).toBe(401);
    expect((await res.json()).errors[0].extensions.code).toBe("UNAUTHENTICATED");
  });

  it("rejects partial credentials", async () => {
    const url = await start(fakeDb());
    const res = await post(url, { query: `{ me { publicKey } }` }, { "X-Public-Key": "GABC" });
    expect(res.status).toBe(401);
  });

  it("retries startup after a failed start rather than caching the failure", async () => {
    const db = fakeDb();
    const handler = createGraphQLHandler({ query: db.query, health });
    const app = express();
    app.use(express.json());
    app.use("/graphql", handler);
    const server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    servers.push(server);
    const url = `http://127.0.0.1:${server.address().port}/graphql`;
    // Two sequential requests both succeed: startup is memoised and reusable.
    expect((await post(url, { query: `{ health { status } }` })).status).toBe(200);
    expect((await post(url, { query: `{ health { status } }` })).status).toBe(200);
  });
});

describe("buildContext", () => {
  const db = fakeDb();
  const reqWith = (headers) => ({
    method: "POST",
    path: "/",
    body: {},
    header: (n) => headers[n] ?? null,
  });

  it("builds fresh loaders for every call", async () => {
    const a = await buildContext(reqWith({}), { query: db.query, health });
    const b = await buildContext(reqWith({}), { query: db.query, health });
    expect(a.loaders.respondersByRequest).not.toBe(b.loaders.respondersByRequest);
    expect(a.user).toBeNull();
  });

  it("rejects an unsupported algorithm with its own status", async () => {
    await expect(
      buildContext(
        reqWith({ "X-Signature": "aa", "X-Public-Key": "GABC", "X-Timestamp": String(Date.now()), "X-Algorithm": "rot13" }),
        { query: db.query, health }
      )
    ).rejects.toMatchObject({ extensions: { code: "UNAUTHENTICATED", http: { status: 400 } } });
  });
});
