import assert from 'node:assert/strict';
import { test } from 'node:test';

globalThis.self = globalThis;
const { createPartialResponse } = await import('workbox-range-requests');

test('cached ZK assets support byte-range responses', async () => {
  const request = new Request('https://example.test/zk-assets/aegis.chunk0000', { headers: { Range: 'bytes=2-4' } });
  const response = await createPartialResponse(request, new Response('abcdefgh'));
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 2-4/8');
  assert.equal(await response.text(), 'cde');
});
