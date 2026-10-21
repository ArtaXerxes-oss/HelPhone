/**
 * GraphQL schema artifact loader.
 *
 * `schema.graphql` is the versioned contract; this module is only the runtime
 * glue. Keeping the SDL in a file lets scripts/detect-api-drift.js diff it
 * against swagger.json and the canonical contract table without executing TS.
 */

import { readFileSync } from 'node:fs';
import { buildSchema, type GraphQLSchema } from 'graphql';

export const schemaPath = new URL('./schema.graphql', import.meta.url);

export const typeDefs = readFileSync(schemaPath, 'utf8');

export const schema: GraphQLSchema = buildSchema(typeDefs);

export default schema;
