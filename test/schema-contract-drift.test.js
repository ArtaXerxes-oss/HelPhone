import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  extractThreeWaySnapshot,
  checkThreeWayAlignment,
  diffAgainstBaseline,
  renderDriftReport,
} from '../scripts/schema-contract-drift.js';

describe('GraphQL / REST / OpenAPI Schema Contract Drift Guard (#946)', () => {
  const root = process.cwd();
  const snapshot = extractThreeWaySnapshot({
    graphqlSdl: fs.readFileSync(path.join(root, 'server/graphql/schema.graphql'), 'utf8'),
    swaggerSpec: JSON.parse(fs.readFileSync(path.join(root, 'swagger.json'), 'utf8')),
    dispatchSource: fs.readFileSync(path.join(root, 'server/routes/dispatch.ts'), 'utf8'),
    syncSource: fs.readFileSync(path.join(root, 'server/routes/sync.ts'), 'utf8'),
  });
  const baseline = JSON.parse(
    fs.readFileSync(path.join(root, 'config/schema-contract-baseline.json'), 'utf8'),
  );

  it('keeps GraphQL, OpenAPI, and Zod contracts aligned with zero breaking drift', () => {
    expect(checkThreeWayAlignment(snapshot)).toEqual([]);
    const diff = diffAgainstBaseline(baseline, snapshot);
    expect(diff.breaking).toEqual([]);
    expect(diff.mismatches).toEqual([]);
  });

  it('classifies removed enum values or fields as breaking', () => {
    const broken = structuredClone(snapshot);
    broken.graphql.enums.Priority = ['low', 'normal', 'high']; // removed 'critical'
    const diff = diffAgainstBaseline(baseline, broken);

    expect(diff.breaking.length).toBeGreaterThan(0);
    expect(diff.mismatches.length).toBeGreaterThan(0);
    expect(renderDriftReport(diff)).toContain('Status: **FAIL**');
  });

  it('classifies new optional fields or OpenAPI paths as additive', () => {
    const extended = structuredClone(snapshot);
    extended.openapi.paths['/api/v1/dispatch'] = ['get', 'post'];
    extended.zod.objects.createIncidentSchema.fields.notes = { required: false };
    const diff = diffAgainstBaseline(baseline, extended);

    expect(diff.breaking).toEqual([]);
    expect(diff.additive).toContain('OpenAPI path added: /api/v1/dispatch');
    expect(diff.additive).toContain('Zod createIncidentSchema.notes added (optional)');
    expect(renderDriftReport(diff)).toContain('Status: **PASS**');
  });
});
