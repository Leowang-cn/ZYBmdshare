import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as dns } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { diagnoseMediaUrl } from '../video.mjs';
import { createNotes } from '../notes.mjs';

const publicRecord = { address: '8.8.8.8', family: 4 };
const privateRecord = { address: '10.0.0.1', family: 4 };
const signedUrl = 'https://media.example.com/audio.mp3?signature=secret';

test('diagnostics use the same DNS rules without leaking signed URLs or fetching media', async context => {
  let records = [publicRecord, { address: '2606:4700:4700::1111', family: 6 }];
  context.mock.method(dns, 'lookup', async () => records);
  for (const client of [http, https]) context.mock.method(client, 'get', () => assert.fail('must not download'));
  const result = await diagnoseMediaUrl(signedUrl);
  assert.equal(result.ok, true);
  assert.equal(result.hostname, 'media.example.com');
  assert.equal(result.allowlistMatched, false);
  assert.deepEqual(result.address, publicRecord);
  assert.deepEqual(result.records.map(record => record.allowed), [true, true]);
  for (const answers of [[privateRecord], [publicRecord, privateRecord], [privateRecord, publicRecord]]) {
    records = answers;
    const denied = await diagnoseMediaUrl(signedUrl);
    assert.equal(denied.ok, false);
    assert.equal(denied.code, 'MEDIA_URL_PRIVATE_ADDRESS');
    assert.equal(denied.address, null);
    assert.equal(denied.records.find(record => record.private).allowed, false);
    assert.doesNotMatch(JSON.stringify(denied), /signature|secret|audio.mp3/);
  }
  for (const url of ['invalid', 'ftp://media.example.com', 'https://user:password@media.example.com', null]) {
    assert.equal((await diagnoseMediaUrl(url)).code, 'MEDIA_URL_INVALID');
  }
  const lookupCalls = dns.lookup.mock.callCount();
  for (const url of ['http://localhost', 'http://127.0.0.1', 'http://[::1]']) {
    assert.equal((await diagnoseMediaUrl(url)).code, 'MEDIA_URL_PRIVATE_ADDRESS');
  }
  assert.equal(dns.lookup.mock.callCount(), lookupCalls);
  records = [];
  assert.equal((await diagnoseMediaUrl(signedUrl)).status, 502);
  context.mock.method(dns, 'lookup', async () => { throw Object.assign(new Error(signedUrl), { code: 'EAI_AGAIN' }); });
  const failure = await diagnoseMediaUrl(signedUrl);
  assert.equal(failure.status, 503);
  assert.equal(failure.code, 'MEDIA_URL_DNS_LOOKUP_FAILED');
  assert.doesNotMatch(JSON.stringify(failure), /signature|secret/);
});

test('diagnostics reveal only the matching host and exact-address exceptions', async context => {
  const previous = process.env.MEDIA_PRIVATE_HOST_ALLOWLIST;
  process.env.MEDIA_PRIVATE_HOST_ALLOWLIST = JSON.stringify({ 'media.example.com': [privateRecord.address], 'other.example.com': ['10.0.0.2'] });
  let configured;
  try { configured = await import(`../video.mjs?diagnostics=${randomUUID()}`); }
  finally {
    if (previous === undefined) delete process.env.MEDIA_PRIVATE_HOST_ALLOWLIST;
    else process.env.MEDIA_PRIVATE_HOST_ALLOWLIST = previous;
  }
  let records = [privateRecord];
  context.mock.method(dns, 'lookup', async () => records);
  const result = await configured.diagnoseMediaUrl(signedUrl);
  assert.equal(result.ok, true);
  assert.equal(result.allowlistMatched, true);
  assert.deepEqual(result.records, [{ ...privateRecord, private: true, allowed: true }]);
  assert.doesNotMatch(JSON.stringify(result), /other.example.com|10.0.0.2/);
  records = [privateRecord, { address: '10.0.0.3', family: 4 }];
  assert.equal((await configured.diagnoseMediaUrl(signedUrl)).ok, false);
  assert.equal((await configured.diagnoseMediaUrl('https://sub.media.example.com')).ok, false);
});

test('media diagnostics require normal API authentication and never mutate notes/jobs', async context => {
  const dataDir = path.resolve(`.media-diagnostic-test-${randomUUID()}`);
  await mkdir(dataDir);
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const state = { version: 1, notes: [], shares: [], attachments: [], videoJobs: [] };
  await writeFile(path.join(dataDir, 'notes.json'), JSON.stringify(state));
  const token = 'media-diagnostic-token';
  const handler = await createNotes({ dataDir, token });
  context.mock.method(dns, 'lookup', async () => [publicRecord]);
  const request = async (route, body, headers = {}, method = 'POST') => {
    const input = Readable.from([Buffer.from(JSON.stringify(body))]);
    Object.assign(input, { method, headers: { host: 'example.com', ...headers }, socket: {} });
    let status, payload, responseHeaders;
    const response = { writeHead(value, headers) { status = value; responseHeaders = headers; }, end(value) { payload = JSON.parse(value); } };
    assert.equal(await handler(input, response, new URL(`http://example.com${route}`)), true);
    return { status, payload, headers: responseHeaders };
  };
  const route = '/api/media/check';
  assert.equal((await request(route, { url: signedUrl })).status, 401);
  assert.equal(dns.lookup.mock.callCount(), 0);
  const auth = { authorization: `Bearer ${token}` };
  const good = await request(route, { url: signedUrl }, auth);
  assert.equal(good.status, 200);
  assert.equal(good.payload.ok, true);
  assert.equal(good.headers['Cache-Control'], 'no-store');
  const rejected = await request(route, { url: 'http://127.0.0.1' }, auth);
  assert.equal(rejected.status, 400);
  assert.equal(rejected.payload.code, 'MEDIA_URL_PRIVATE_ADDRESS');
  assert.equal((await request(route, {}, auth)).status, 400);
  assert.equal((await request(route, {}, auth, 'GET')).status, 404);
  const login = await request('/api/session', { token });
  const cookie = login.headers['Set-Cookie'].split(';')[0];
  assert.equal((await request(route, { url: signedUrl }, { cookie })).status, 403);
  assert.equal((await request(route, { url: signedUrl }, { cookie, origin: 'http://evil.example' })).status, 403);
  assert.equal((await request(route, { url: signedUrl }, { cookie, origin: 'http://example.com' })).status, 200);
  assert.deepEqual(JSON.parse(await readFile(path.join(dataDir, 'notes.json'), 'utf8')), state);
});
