#!/usr/bin/env node
/**
 * API drift gate: REST ↔ GraphQL ↔ canonical contract ↔ dependency pins.
 *
 * The old gate only compared version strings. This one fails on semantic
 * drift:
 *   - contract fields missing from the GraphQL SDL (or nullability/type drift);
 *   - enum value drift;
 *   - operations missing from swagger.json or the GraphQL Query/Mutation;
 *   - unreviewed contract edits (contractHash);
 *   - dependency pin drift (exact by default with --require-exact-pin).
 *
 * Usage:
 *   node scripts/detect-api-drift.js --check
 *   node scripts/detect-api-drift.js --update
 *   node scripts/detect-api-drift.js --require-exact-pin
 *   node scripts/detect-api-drift.js --json
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSchema } from 'graphql';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const update = args.has('--update');
const requireExactPin = args.has('--require-exact-pin');
const jsonOutput = args.has('--json');

function readJson(path) {
  return JSON.parse(readFileSync(resolve(ROOT, path), 'utf8'));
}

function readText(path) {
  return readFileSync(resolve(ROOT, path), 'utf8');
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function installedVersion(name) {
  const lock = readJson('package-lock.json');
  return lock.packages?.[`node_modules/${name}`]?.version ?? null;
}

function parseOperation(value) {
  if (!value || typeof value !== 'string') return null;
  const [method, path] = value.split(/\s+/, 2);
  return { method: method.toLowerCase(), path };
}

const packageJson = readJson('package.json');
const driftConfig = packageJson.apiDrift ?? {};
const baseline = driftConfig.baseline ?? {};
const contractPath = driftConfig.contract ?? 'server/contract/domain-contract.json';
const graphqlPath = driftConfig.graphqlSchema ?? 'server/graphql/schema.graphql';
const openapiPath = driftConfig.openapi ?? 'swagger.json';

const contractText = readText(contractPath);
const contract = JSON.parse(contractText);
const contractHash = sha256(JSON.stringify(contract));
const schema = buildSchema(readText(graphqlPath));
const openapi = readJson(openapiPath);

const errors = [];
const warnings = [];
const checked = {
  entities: 0,
  fields: 0,
  enums: 0,
  operations: 0,
  pins: 0,
};

function fail(message) {
  errors.push(message);
}

function warn(message) {
  warnings.push(message);
}

// ── Contract hash ───────────────────────────────────────────────────────────
if (baseline.contractHash && baseline.contractHash !== contractHash) {
  fail(
    `contract hash drift: ${contractPath} changed without a reviewed baseline update ` +
      `(expected ${baseline.contractHash.slice(0, 12)}…, got ${contractHash.slice(0, 12)}…). ` +
      'Run npm run security:api-drift:update after review.',
  );
} else if (!baseline.contractHash && !update) {
  warn(`no contractHash in package.json:apiDrift.baseline (run --update to record ${contractHash.slice(0, 12)}…)`);
}

// ── OpenAPI sanity ──────────────────────────────────────────────────────────
if (!openapi.openapi) fail(`${openapiPath}: missing openapi version`);
if (!openapi.paths || typeof openapi.paths !== 'object') fail(`${openapiPath}: missing paths`);
const paths = openapi.paths ?? {};

function hasRestOperation(operation) {
  const parsed = parseOperation(operation);
  if (!parsed) return false;
  const path = paths[parsed.path];
  return Boolean(path && path[parsed.method]);
}

// ── GraphQL entities + fields ───────────────────────────────────────────────
const typeMap = schema.getTypeMap();
for (const [entityName, entity] of Object.entries(contract.entities ?? {})) {
  checked.entities++;
  const gqlType = typeMap[entityName];
  if (!gqlType) {
    fail(`GraphQL type missing: ${entityName}`);
    continue;
  }
  if (entity.restPath && !paths[entity.restPath]) {
    fail(`REST path missing from ${openapiPath}: ${entity.restPath} (entity ${entityName})`);
  }

  const gqlFields = typeof gqlType.getFields === 'function' ? gqlType.getFields() : {};
  for (const [fieldName, field] of Object.entries(entity.fields ?? {})) {
    checked.fields++;
    const gqlField = gqlFields[fieldName];
    if (!gqlField) {
      fail(`GraphQL field missing: ${entityName}.${fieldName}`);
      continue;
    }
    const actual = gqlField.type.toString();
    if (actual !== field.graphqlType) {
      fail(
        `GraphQL type drift: ${entityName}.${fieldName} expected ${field.graphqlType}, got ${actual}`,
      );
    }
    const nullable = !actual.endsWith('!');
    if (Boolean(field.nullable) !== nullable) {
      fail(
        `GraphQL nullability drift: ${entityName}.${fieldName} expected nullable=${field.nullable}, got ${nullable}`,
      );
    }
  }

  // Cover every field declared in the SDL for checked entities.
  for (const fieldName of Object.keys(gqlFields)) {
    if (!entity.fields?.[fieldName]) {
      fail(`unmapped GraphQL field (add it to ${contractPath}): ${entityName}.${fieldName}`);
    }
  }
}

// ── Enum values ─────────────────────────────────────────────────────────────
for (const [enumName, expectedValues] of Object.entries(contract.enums ?? {})) {
  checked.enums++;
  const gqlEnum = typeMap[enumName];
  if (!gqlEnum || typeof gqlEnum.getValues !== 'function') {
    fail(`GraphQL enum missing: ${enumName}`);
    continue;
  }
  const actual = gqlEnum.getValues().map((value) => value.name);
  if (JSON.stringify(actual) !== JSON.stringify(expectedValues)) {
    fail(
      `enum drift: ${enumName} expected [${expectedValues.join(', ')}], got [${actual.join(', ')}]`,
    );
  }
  const restSchemas = Object.values(openapi.components?.schemas ?? {});
  for (const schemaDef of restSchemas) {
    const properties = schemaDef?.properties ?? {};
    for (const [property, definition] of Object.entries(properties)) {
      // Only compare schemas that explicitly opt in via x-enum-name; a
      // heuristic on shared values (e.g. "assigned") creates false positives.
      if (definition?.['x-enum-name'] === enumName) {
        if (JSON.stringify(definition.enum) !== JSON.stringify(expectedValues)) {
          fail(
            `REST enum drift: components.schemas.${property} expected [${expectedValues.join(', ')}], got [${definition.enum.join(', ')}]`,
          );
        }
      }
    }
  }
}

// ── Operations ──────────────────────────────────────────────────────────────
function hasGraphQLOperation(operation) {
  if (!operation) return true;
  const [root, field] = operation.split('.');
  const type = typeMap[root];
  if (!type) return false;
  const fields = type.getFields();
  return Boolean(fields[field]);
}

for (const [name, operation] of Object.entries(contract.operations ?? {})) {
  checked.operations++;
  if (!hasRestOperation(operation.rest)) {
    fail(`operation ${name}: REST ${operation.rest} missing from ${openapiPath}`);
  }
  if (!hasGraphQLOperation(operation.graphql)) {
    fail(`operation ${name}: GraphQL ${operation.graphql} missing from ${graphqlPath}`);
  }
}

// ── Dependency pins ─────────────────────────────────────────────────────────
for (const [name, expected] of Object.entries(baseline)) {
  if (name === 'contractHash') continue;
  checked.pins++;
  const actual = installedVersion(name);
  if (!actual) {
    fail(`pinned dependency not installed: ${name}`);
    continue;
  }
  if (requireExactPin && /[\^~><=*]/.test(expected)) {
    fail(`pin ${name} is not exact: ${expected}`);
  }
  if (actual !== expected) {
    fail(`dependency drift: ${name} pinned ${expected}, installed ${actual}. Run npm run security:api-drift:update after review.`);
  }
}

// ── Update mode ─────────────────────────────────────────────────────────────
if (update) {
  const next = { ...packageJson };
  next.apiDrift = {
    ...driftConfig,
    baseline: {
      ...baseline,
      contractHash,
    },
  };
  for (const name of Object.keys(baseline)) {
    if (name === 'contractHash') continue;
    const actual = installedVersion(name);
    if (actual) next.apiDrift.baseline[name] = actual;
  }
  writeFileSync(resolve(ROOT, 'package.json'), `${JSON.stringify(next, null, 2)}\n`);
}

const result = {
  ok: errors.length === 0,
  checked,
  contractHash,
  errors,
  warnings,
};

if (jsonOutput) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`api-drift: checked ${checked.entities} entities, ${checked.fields} fields, ${checked.enums} enums, ${checked.operations} operations, ${checked.pins} pins`);
  for (const warning of warnings) console.warn(`api-drift: warning: ${warning}`);
  for (const error of errors) console.error(`api-drift: FAIL: ${error}`);
  console.log(errors.length === 0 ? 'api-drift: OK' : `api-drift: ${errors.length} failure(s)`);
}

process.exit(errors.length === 0 ? 0 : 1);
