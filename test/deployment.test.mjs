import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createProbe, parsePort } from '../server.mjs';

test('platform port handling', () => {
  assert.equal(parsePort([], {}), 8080);
  assert.equal(parsePort([], { PORT: '8913' }), 8913);
  assert.equal(parsePort(['--port', '8914'], { PORT: '8913' }), 8914);
  for (const value of ['0', '65536', '-1', 'abc', '8000x']) {
    assert.throws(() => parsePort([], { PORT: value }));
  }
  assert.throws(() => parsePort(['--port'], {}));
});

test('health, authentication, methods and persistence across restarts', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'mdshare-test-'));
  const token = 'local-test-token-not-for-production';
  let server;
  try {
    await assert.rejects(createProbe({ dataDir, token: '' }), /ACCESS_TOKEN/);
    server = await createProbe({ dataDir, token });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    assert.equal((await fetch(`${base}/api/report`)).status, 401);
    assert.equal((await fetch(`${base}/api/report`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await fetch(`${base}/missing`)).status, 404);
    assert.equal((await fetch(`${base}/api/health`, { method: 'POST' })).status, 405);
    const first = await (await fetch(`${base}/api/report`, { headers: { Authorization: `Bearer ${token}` } })).json();
    assert.equal(first.persistence.boots, 1);
    assert.equal(JSON.stringify(first).includes(token), false);
    await new Promise(resolve => server.close(resolve));
    server = await createProbe({ dataDir, token });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const second = await (await fetch(`http://127.0.0.1:${server.address().port}/api/report`, { headers: { Authorization: `Bearer ${token}` } })).json();
    assert.equal(second.persistence.id, first.persistence.id);
    assert.equal(second.persistence.boots, 2);
    await writeFile(path.join(dataDir, 'probe.json'), 'corrupt');
    await assert.rejects(createProbe({ dataDir, token }));
    await rm(path.join(dataDir, 'probe.json'));
    assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/api/health`)).status, 503);
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});