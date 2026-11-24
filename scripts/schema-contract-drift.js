#!/usr/bin/env node
// #946 — Three-way GraphQL / REST (Zod) / OpenAPI (swagger.json) contract drift guard.
//
// Compares:
//   1. GraphQL SDL: server/graphql/schema.graphql
//   2. OpenAPI spec: swagger.json
//   3. Zod REST schemas: server/routes/dispatch.ts, server/routes/sync.ts
//
// Classifies differences against config/schema-contract-baseline.json as:
//   - breaking (fails CI): removed enum/field/operation, tightened optional->required,
//     type mismatch, or three-way cross-contract divergence
//   - additive (reviewable diff): new enum value across all contracts, new optional field,
//     new endpoint/type
//
// Usage:
//   node scripts/schema-contract-drift.js [--check] [--update] [--report <path>] [--json]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Parse enums, types, and inputs from GraphQL SDL text. */
export function parseGraphQLContract(sdl) {
  const enums = {};
  const types = {};

  const enumRe = /enum\s+(\w+)\s*\{([^}]*)\}/g;
  let m;
  while ((m = enumRe.exec(sdl)) !== null) {
    enums[m[1]] = m[2]
      .split(/\r?\n/)
      .map((l) => l.replace(/#.*$/, "").trim())
      .filter(Boolean);
  }

  const blockRe = /(type|input)\s+(\w+)\s*\{([^}]*)\}/g;
  while ((m = blockRe.exec(sdl)) !== null) {
    const kind = m[1];
    const name = m[2];
    const fields = {};
    for (const rawLine of m[3].split(/\r?\n/)) {
      const line = rawLine.replace(/#.*$/, "").trim();
      if (!line) continue;
      const fieldMatch = line.match(/^(\w+)(?:\([^)]*\))?\s*:\s*([^\s=]+)/);
      if (!fieldMatch) continue;
      const fieldName = fieldMatch[1];
      const rawType = fieldMatch[2];
      fields[fieldName] = {
        type: rawType.replace(/!/g, ""),
        required: rawType.endsWith("!"),
      };
    }
    types[name] = { kind, fields };
  }

  return { enums, types };
}

/** Parse Zod enum and object schemas from server route TypeScript files. */
export function parseZodSchemas(sourceText) {
  const enums = {};
  const objects = {};

  const enumRe = /const\s+(\w+)\s*=\s*z\.enum\(\s*\[([^\]]+)\]\s*\)/g;
  let m;
  while ((m = enumRe.exec(sourceText)) !== null) {
    enums[m[1]] = m[2]
      .split(",")
      .map((v) => v.trim().replace(/^['"]|['"]$/g, ""))
      .filter(Boolean);
  }

  const objRe = /const\s+(\w+)\s*=\s*z\.object\(\s*\{([\s\S]*?)\}\s*\)/g;
  while ((m = objRe.exec(sourceText)) !== null) {
    const name = m[1];
    const body = m[2];
    const fields = {};
    for (const rawLine of body.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("//")) continue;
      const fm = line.match(/^(\w+)\s*:\s*(.+?)(?:,)?$/);
      if (!fm) continue;
      const fieldName = fm[1];
      const expr = fm[2];
      fields[fieldName] = {
        required: !expr.includes(".optional()"),
        expr,
      };
    }
    objects[name] = { fields };
  }

  return { enums, objects };
}

/** Parse OpenAPI paths and component schemas from swagger.json object. */
export function parseOpenApiContract(spec) {
  const paths = {};
  for (const [route, methods] of Object.entries(spec?.paths || {})) {
    paths[route] = Object.keys(methods || {})
      .filter((k) => ["get", "post", "put", "patch", "delete"].includes(k.toLowerCase()))
      .sort();
  }

  const schemas = {};
  for (const [name, def] of Object.entries(spec?.components?.schemas || {})) {
    const requiredSet = new Set(def.required || []);
    const fields = {};
    for (const [prop, propDef] of Object.entries(def.properties || {})) {
      fields[prop] = {
        type: propDef.type || (propDef.$ref ? "ref" : "unknown"),
        required: requiredSet.has(prop),
        enum: propDef.enum || null,
      };
    }
    schemas[name] = { fields };
  }

  return { paths, schemas };
}

/**
 * Extract the unified three-way contract snapshot from GraphQL, OpenAPI, and Zod.
 */
export function extractThreeWaySnapshot({ graphqlSdl, swaggerSpec, dispatchSource, syncSource }) {
  const graphql = parseGraphQLContract(graphqlSdl);
  const openapi = parseOpenApiContract(swaggerSpec);
  const zodDispatch = parseZodSchemas(dispatchSource);
  const zodSync = parseZodSchemas(syncSource);

  return {
    graphql,
    openapi,
    zod: {
      enums: { ...zodDispatch.enums, ...zodSync.enums },
      objects: { ...zodDispatch.objects, ...zodSync.objects },
    },
  };
}

/**
 * Verify three-way alignment across GraphQL, OpenAPI, and Zod for shared domain contracts.
 */
export function checkThreeWayAlignment(snapshot) {
  const mismatches = [];

  const compareSets = (label, a, b) => {
    const setA = new Set(a || []);
    const setB = new Set(b || []);
    for (const item of setA) {
      if (!setB.has(item)) mismatches.push(`${label}: missing "${item}" in target contract`);
    }
    for (const item of setB) {
      if (!setA.has(item)) mismatches.push(`${label}: extra "${item}" in target contract`);
    }
  };

  // 1. Enum parity: IncidentStatus & Priority
  const gqlStatus = snapshot.graphql.enums.IncidentStatus || [];
  const zodStatus = snapshot.zod.enums.statusSchema || [];
  const oasStatus = snapshot.openapi.schemas.CreateIncident?.fields?.status?.enum || [];
  compareSets("IncidentStatus (GraphQL vs Zod)", gqlStatus, zodStatus);
  compareSets("IncidentStatus (GraphQL vs OpenAPI)", gqlStatus, oasStatus);

  const gqlPriority = snapshot.graphql.enums.Priority || [];
  const zodPriority = snapshot.zod.enums.prioritySchema || [];
  const oasPriority = snapshot.openapi.schemas.CreateIncident?.fields?.priority?.enum || [];
  compareSets("Priority (GraphQL vs Zod)", gqlPriority, zodPriority);
  compareSets("Priority (GraphQL vs OpenAPI)", gqlPriority, oasPriority);

  // 2. Shared object parity: Location, CreateIncident, AssignResponderInput, SyncFlushInput
  const gqlLoc = Object.keys(snapshot.graphql.types.Location?.fields || {});
  const zodLoc = Object.keys(snapshot.zod.objects.locationSchema?.fields || {});
  compareSets("Location fields (GraphQL vs Zod)", gqlLoc, zodLoc);

  const zodCreate = Object.keys(snapshot.zod.objects.createIncidentSchema?.fields || {});
  const oasCreate = Object.keys(snapshot.openapi.schemas.CreateIncident?.fields || {});
  compareSets("CreateIncident fields (Zod vs OpenAPI)", zodCreate, oasCreate);

  const gqlAssign = Object.keys(snapshot.graphql.types.AssignResponderInput?.fields || {}).filter(
    (f) => f !== "incidentId",
  );
  const zodAssign = Object.keys(snapshot.zod.objects.assignSchema?.fields || {});
  compareSets("AssignResponder fields (GraphQL vs Zod)", gqlAssign, zodAssign);

  const gqlFlush = Object.keys(snapshot.graphql.types.SyncFlushInput?.fields || {});
  const zodFlush = Object.keys(snapshot.zod.objects.flushSchema?.fields || {});
  compareSets("SyncFlushInput fields (GraphQL vs Zod)", gqlFlush, zodFlush);

  return mismatches;
}

/**
 * Compare current snapshot against baseline and classify every diff as breaking or additive.
 */
export function diffAgainstBaseline(baseline, current) {
  const breaking = [];
  const additive = [];

  if (!baseline) {
    return { breaking, additive, mismatches: checkThreeWayAlignment(current) };
  }

  // GraphQL enums
  for (const [name, vals] of Object.entries(baseline.graphql?.enums || {})) {
    const curVals = current.graphql?.enums?.[name];
    if (!curVals) {
      breaking.push(`GraphQL enum removed: ${name}`);
      continue;
    }
    for (const v of vals) {
      if (!curVals.includes(v)) breaking.push(`GraphQL enum ${name} removed value: ${v}`);
    }
    for (const v of curVals) {
      if (!vals.includes(v)) additive.push(`GraphQL enum ${name} added value: ${v}`);
    }
  }
  for (const name of Object.keys(current.graphql?.enums || {})) {
    if (!baseline.graphql?.enums?.[name]) additive.push(`GraphQL enum added: ${name}`);
  }

  // GraphQL types & inputs
  for (const [name, def] of Object.entries(baseline.graphql?.types || {})) {
    const curDef = current.graphql?.types?.[name];
    if (!curDef) {
      breaking.push(`GraphQL ${def.kind} removed: ${name}`);
      continue;
    }
    for (const [field, fDef] of Object.entries(def.fields || {})) {
      const curField = curDef.fields?.[field];
      if (!curField) {
        breaking.push(`GraphQL ${name}.${field} removed`);
        continue;
      }
      if (curField.type !== fDef.type) {
        breaking.push(`GraphQL ${name}.${field} type changed (${fDef.type} -> ${curField.type})`);
      }
      if (!fDef.required && curField.required && def.kind === "input") {
        breaking.push(`GraphQL ${name}.${field} became required`);
      }
    }
    for (const [field, curField] of Object.entries(curDef.fields || {})) {
      if (!def.fields?.[field]) {
        if (def.kind === "input" && curField.required) {
          breaking.push(`GraphQL input ${name}.${field} added as required`);
        } else {
          additive.push(`GraphQL ${name}.${field} added`);
        }
      }
    }
  }

  // OpenAPI paths
  for (const [route, methods] of Object.entries(baseline.openapi?.paths || {})) {
    const curMethods = current.openapi?.paths?.[route];
    if (!curMethods) {
      breaking.push(`OpenAPI path removed: ${route}`);
      continue;
    }
    for (const m of methods) {
      if (!curMethods.includes(m)) breaking.push(`OpenAPI operation removed: ${m.toUpperCase()} ${route}`);
    }
    for (const m of curMethods) {
      if (!methods.includes(m)) additive.push(`OpenAPI operation added: ${m.toUpperCase()} ${route}`);
    }
  }
  for (const route of Object.keys(current.openapi?.paths || {})) {
    if (!baseline.openapi?.paths?.[route]) additive.push(`OpenAPI path added: ${route}`);
  }

  // Zod objects
  for (const [name, def] of Object.entries(baseline.zod?.objects || {})) {
    const curDef = current.zod?.objects?.[name];
    if (!curDef) {
      breaking.push(`Zod schema removed: ${name}`);
      continue;
    }
    for (const [field, fDef] of Object.entries(def.fields || {})) {
      const curField = curDef.fields?.[field];
      if (!curField) {
        breaking.push(`Zod ${name}.${field} removed`);
        continue;
      }
      if (!fDef.required && curField.required) {
        breaking.push(`Zod ${name}.${field} became required`);
      }
    }
    for (const [field, curField] of Object.entries(curDef.fields || {})) {
      if (!def.fields?.[field]) {
        if (curField.required) breaking.push(`Zod ${name}.${field} added as required`);
        else additive.push(`Zod ${name}.${field} added (optional)`);
      }
    }
  }

  const mismatches = checkThreeWayAlignment(current);
  return { breaking, additive, mismatches };
}

/** Render a human-readable Markdown drift report. */
export function renderDriftReport({ breaking, additive, mismatches }) {
  const status = breaking.length === 0 && mismatches.length === 0 ? "PASS" : "FAIL";
  const lines = [
    "# Schema Contract Drift Report (#946)",
    "",
    `Status: **${status}**`,
    "",
    `- Three-way contract mismatches: ${mismatches.length}`,
    `- Breaking changes vs baseline: ${breaking.length}`,
    `- Additive changes vs baseline: ${additive.length}`,
    "",
  ];

  if (mismatches.length) {
    lines.push("## Three-Way Contract Mismatches (Breaking)", "");
    for (const m of mismatches) lines.push(`- ${m}`);
    lines.push("");
  }
  if (breaking.length) {
    lines.push("## Breaking Changes", "");
    for (const b of breaking) lines.push(`- ${b}`);
    lines.push("");
  }
  if (additive.length) {
    lines.push("## Additive Changes (Reviewable Diff)", "");
    for (const a of additive) lines.push(`- ${a}`);
    lines.push("");
  }
  return lines.join("\n");
}

function main() {
  const args = process.argv.slice(2);
  const graphqlPath = path.resolve(REPO_ROOT, "server/graphql/schema.graphql");
  const swaggerPath = path.resolve(REPO_ROOT, "swagger.json");
  const dispatchPath = path.resolve(REPO_ROOT, "server/routes/dispatch.ts");
  const syncPath = path.resolve(REPO_ROOT, "server/routes/sync.ts");
  const baselinePath = path.resolve(REPO_ROOT, "config/schema-contract-baseline.json");

  const current = extractThreeWaySnapshot({
    graphqlSdl: fs.readFileSync(graphqlPath, "utf8"),
    swaggerSpec: JSON.parse(fs.readFileSync(swaggerPath, "utf8")),
    dispatchSource: fs.readFileSync(dispatchPath, "utf8"),
    syncSource: fs.readFileSync(syncPath, "utf8"),
  });

  if (args.includes("--update")) {
    const mismatches = checkThreeWayAlignment(current);
    if (mismatches.length) {
      for (const m of mismatches) console.error(`schema-drift: FAIL ${m}`);
      process.exit(1);
    }
    fs.writeFileSync(baselinePath, JSON.stringify(current, null, 2) + "\n");
    console.log(`schema-drift: updated ${path.relative(REPO_ROOT, baselinePath)}`);
    return;
  }

  const baseline = fs.existsSync(baselinePath)
    ? JSON.parse(fs.readFileSync(baselinePath, "utf8"))
    : null;
  const result = diffAgainstBaseline(baseline, current);
  const reportIdx = args.indexOf("--report");
  if (reportIdx !== -1 && args[reportIdx + 1]) {
    const outPath = path.resolve(REPO_ROOT, args[reportIdx + 1]);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, renderDriftReport(result));
  }

  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(renderDriftReport(result));
  }

  const hasBreaking = result.breaking.length > 0 || result.mismatches.length > 0;
  process.exit(hasBreaking ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
