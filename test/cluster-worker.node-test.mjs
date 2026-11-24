import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

test('cluster worker indexes points and returns viewport clusters', async () => {
  const source = await readFile(new URL('../src/workers/cluster-worker.js', import.meta.url), 'utf8');
  const messages = [];
  const self = { onmessage: null, postMessage: (message) => messages.push(message) };
  runInNewContext(source, { self, performance: { now: () => 1 } });
  const features = [
    { type: 'Feature', id: 'a', properties: { pointId: 'a' } },
    { type: 'Feature', id: 'b', properties: { pointId: 'b' } },
    { type: 'Feature', id: 'c', properties: { pointId: 'c' } },
  ];
  self.onmessage({ data: { id: 1, type: 'load', coordinates: new Float64Array([1, 1, 1.0001, 1.0001, 9, 9]).buffer, features } });
  assert.equal(messages.pop().type, 'loaded');
  self.onmessage({ data: { id: 2, type: 'query', bounds: [-5, -5, 10, 10], zoom: 5, radius: 60 } });
  const result = messages.pop();
  assert.equal(result.type, 'result');
  assert.equal(result.features.find((feature) => feature.properties.cluster)?.properties.point_count, 2);
  assert.ok(result.features.some((feature) => feature.properties.pointId === 'c'));
});
