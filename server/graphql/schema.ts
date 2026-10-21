/**
 * server/graphql/schema.ts — unified GraphQL schema (#528)
 *
 * Aggregates the Postgres-backed help-request data behind one endpoint. Only
 * the indexed columns are typed (see migrations/); anything else on a row is
 * passed through in `attributes` so the schema never invents columns.
 */
export const typeDefs = /* GraphQL */ `
  """
  Arbitrary JSON (the untyped remainder of a database row).
  """
  scalar JSON

  type PoolStats {
    total: Int!
    active: Int!
    idle: Int!
    waiting: Int!
    maxConnections: Int!
  }

  type Health {
    status: String!
    database: Boolean!
    databaseLatencyMs: Int!
    pool: PoolStats!
  }

  type AuthUser {
    publicKey: String!
    algorithm: String!
  }

  type Responder {
    requestId: ID!
    arrived: Boolean!
    attributes: JSON!
  }

  type HelpRequest {
    id: ID!
    status: String
    createdAt: String
    attributes: JSON!
    "Responders on this request. Batched across sibling requests: one query per page, not one per request."
    responders: [Responder!]!
    responderCount: Int!
    arrivedCount: Int!
  }

  type Verification {
    wallet: String!
    recordedAt: String
    attributes: JSON!
  }

  type Query {
    health: Health!
    "Newest first. limit is capped at 100."
    requests(status: String, limit: Int = 20, offset: Int = 0): [HelpRequest!]!
    request(id: ID!): HelpRequest
    "Expert verification history for a wallet, newest first. limit is capped at 100."
    verifications(wallet: String!, limit: Int = 10): [Verification!]!
    "The caller, when the request carries valid X-Signature auth headers; null otherwise."
    me: AuthUser
  }
`
