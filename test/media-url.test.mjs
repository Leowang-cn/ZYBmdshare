import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as dns } from 'node:dns';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { checkUrl, MediaUrlError } from '../video.mjs';
import { createNotes } from '../notes.mjs';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { parseMediaPrivateHostAllowlist } from '../video.mjs';

const hostname = 'zyb-nt-resource-1253445850.cos.ap-beijing.myqcloud.com';
const mediaUrl = `https://${hostname}/0leoshare/1009%20%E8%AF%BE%E7%A8%8B%E5%88%B6%E4%BD%9C/%E6%9D%8E%E6%B4%81%E9%9F%B3%E9%A2%91.mp3`;
const signedUrl = `${mediaUrl}?signature=secret-test-signature`;

test('private media DNS exceptions require exact hostname and every private answer', async context => {
  const previous = process.env.MEDIA_PRIVATE_HOST_ALLOWLIST;
  process.env.MEDIA_PRIVATE_HOST_ALLOWLIST = JSON.stringify({ [hostname]: ['10.118.35.11'] });
  let configured;
  try { configured = await import(`../video.mjs?allowlist=${randomUUID()}`); }
  finally {
    if (previous === undefined) delete process.env.MEDIA_PRIVATE_HOST_ALLOWLIST;
    else process.env.MEDIA_PRIVATE_HOST_ALLOWLIST = previous;
  }
  const allowed = { address: '10.118.35.11', family: 4 };
  const publicRecord = { address: '61.179.133.117', family: 4 };
  const denied = { address: '10.118.35.12', family: 4 };
  let records = [allowed];
  context.mock.method(dns, 'lookup', async () => records);
  const rejectsPrivate = promise => assert.rejects(promise, error => error.code === 'MEDIA_URL_PRIVATE_ADDRESS' && error.status === 400);
  await rejectsPrivate(checkUrl(mediaUrl));
  assert.deepEqual((await configured.checkUrl(mediaUrl)).address, allowed);
  for (const host of ['other.example.com', `sub.${hostname}`, `${hostname}.`, '10.118.35.11', '[::1]', '0x0a76230b']) {
    await rejectsPrivate(configured.checkUrl(`http://${host}/audio.mp3`));
  }
  for (const answers of [[denied], [allowed, denied], [denied, allowed], [publicRecord, allowed, denied]]) {
    records = answers;
    await rejectsPrivate(configured.checkUrl(mediaUrl));
  }
  for (const answers of [[allowed, publicRecord], [publicRecord, allowed]]) {
    records = answers;
    assert.deepEqual((await configured.checkUrl(mediaUrl)).address, answers[0]);
  }
  records = [allowed];
  let requests = 0;
  context.mock.method(http, 'get', (url, options, callback) => {
    requests += 1;
    assert.equal(url.hostname, hostname);
    options.lookup(hostname, { all: true }, (error, addresses) => {
      assert.equal(error, null);
      assert.deepEqual(addresses, [allowed]);
    });
    options.lookup(hostname, {}, (error, address, family) => {
      assert.equal(error, null);
      assert.equal(address, allowed.address);
      assert.equal(family, 4);
    });
    callback({ statusCode: 302, headers: { location: 'http://other.example.com/audio.mp3' }, destroy() {} });
    return new EventEmitter();
  });
  await rejectsPrivate(configured.download(`http://${hostname}/audio.mp3`, path.resolve('.unused-media-download')));
  assert.equal(requests, 1);
});

test('private media DNS exception configuration fails clearly at startup', () => {
  assert.equal(parseMediaPrivateHostAllowlist().size, 0);
  assert.equal(parseMediaPrivateHostAllowlist(JSON.stringify({ [hostname]: ['10.118.35.11'] })).get(hostname).has('10.118.35.11'), true);
  const invalid = ['not-json', '', 'null', '[]', '42', '"text"'];
  for (const key of ['10.118.35.11', '[::1]', '127.1', '0x7f.1', 'localhost', 'test.local', 'test.localhost', '*.example.com', 'https://example.com', 'EXAMPLE.com', 'example.com.', '-bad.example.com', 'bad_label.example.com']) invalid.push(JSON.stringify({ [key]: ['10.118.35.11'] }));
  for (const addresses of [null, {}, [], '10.118.35.11', [42], [''], ['bad'], ['10.118.35.0/24'], [' 10.118.35.11'], ['8.8.8.8'], ['fe80::1%eth0']]) invalid.push(JSON.stringify({ [hostname]: addresses }));
  for (const value of invalid) assert.throws(() => parseMediaPrivateHostAllowlist(value), /Invalid MEDIA_PRIVATE_HOST_ALLOWLIST:/);
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', 'await import("./video.mjs")'], {
    cwd: path.resolve('.'), env: { ...process.env, MEDIA_PRIVATE_HOST_ALLOWLIST: '{' }, encoding: 'utf8'
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid MEDIA_PRIVATE_HOST_ALLOWLIST: expected a JSON object/);
});

test('media URL validation distinguishes DNS errors without leaking signed URLs', async context => {
  for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'ENODATA', undefined, 'secret-test-signature']) {
    const mock = context.mock.method(dns, 'lookup', async (host, options) => {
      assert.equal(host, hostname);
      assert.deepEqual(options, { all: true, verbatim: true });
      if (code === 'ENODATA') return [];
      throw Object.assign(new Error(`sensitive details: ${signedUrl}`), { code });
    });
    try {
      await assert.rejects(checkUrl(signedUrl), error => {
        assert.ok(error instanceof MediaUrlError);
        assert.equal(error.code, 'MEDIA_URL_DNS_LOOKUP_FAILED');
        assert.equal(error.status, code === 'EAI_AGAIN' ? 503 : 502);
        assert.ok(error.message.includes(hostname));
        assert.ok(error.message.includes(['ENOTFOUND', 'EAI_AGAIN', 'ENODATA'].includes(code) ? code : 'UNKNOWN'));
        assert.doesNotMatch(error.message, /signature|0leoshare|sensitive details/);
        return true;
      });
    } finally { mock.mock.restore(); }
  }
});

test('media URL validation accepts supplied public URL but blocks every mixed DNS ordering', async context => {
  const publicRecord = { address: '61.179.133.117', family: 4 };
  const privateRecord = { address: '10.0.0.1', family: 4 };
  let records = [publicRecord];
  context.mock.method(dns, 'lookup', async () => records);
  assert.deepEqual((await checkUrl(mediaUrl)).address, publicRecord);
  for (const blocked of [[privateRecord], [publicRecord, privateRecord], [privateRecord, publicRecord], [publicRecord, { address: '::1', family: 6 }]]) {
    records = blocked;
    await assert.rejects(checkUrl(signedUrl), error => error.code === 'MEDIA_URL_PRIVATE_ADDRESS' && error.status === 400 && /内网或保留地址/.test(error.message));
  }
  for (const value of ['not a URL', 'ftp://example.com/audio.mp3', 'https://user:password@example.com/audio.mp3', `https://example.com/${'a'.repeat(4096)}`, null]) {
    await assert.rejects(checkUrl(value), error => error.code === 'MEDIA_URL_INVALID' && error.status === 400 && !/DNS/.test(error.message));
  }
  await assert.rejects(checkUrl('http://localhost/audio.mp3'), error => error.code === 'MEDIA_URL_PRIVATE_ADDRESS');
});

test('media submission route reports distinct safe errors and creates no jobs on rejection', async context => {
  const dataDir = path.resolve(`.media-url-test-${randomUUID()}`);
  await mkdir(dataDir);
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  await writeFile(path.join(dataDir, 'notes.json'), JSON.stringify({ version: 1, notes: [{ id: 'parent', title: 'Parent', markdown: '', revision: 1 }], shares: [], attachments: [], videoJobs: [] }));
  const token = 'media-url-test-token';
  const handler = await createNotes({ dataDir, token });
  let lookupResult;
  context.mock.method(dns, 'lookup', async () => {
    if (lookupResult instanceof Error) throw lookupResult;
    return lookupResult;
  });
  const cases = [
    { code: 'ENOTFOUND', status: 502, pattern: /DNS 解析失败.*ENOTFOUND/ },
    { code: 'EAI_AGAIN', status: 503, pattern: /DNS 解析失败.*EAI_AGAIN/ },
    { records: [], status: 502, pattern: /DNS 解析失败.*ENODATA/ },
    { records: [{ address: '10.0.0.1', family: 4 }], status: 400, pattern: /内网或保留地址/ },
    { records: [{ address: '61.179.133.117', family: 4 }, { address: '127.0.0.1', family: 4 }], status: 400, pattern: /内网或保留地址/ },
    { url: 'invalid', status: 400, pattern: /URL 无效/ },
    { unexpected: true, status: 500, pattern: /URL 校验失败/ }
  ];
  for (const item of cases) {
    lookupResult = item.code || item.unexpected ? Object.assign(new Error(signedUrl), { code: item.code }) : item.records;
    // Only typed validation errors are safe to expose, even if another validator fails unexpectedly.
    const mock = item.unexpected ? context.mock.method(dns, 'lookup', async () => ({ some() { throw new Error(signedUrl); }, length: 1 })) : null;
    const request = Readable.from([Buffer.from(JSON.stringify({ urls: [item.url || signedUrl] }))]);
    Object.assign(request, { method: 'POST', headers: { authorization: `Bearer ${token}` }, socket: {} });
    let status, payload;
    const response = { writeHead(value) { status = value; }, end(value) { payload = JSON.parse(value); } };
    try { assert.equal(await handler(request, response, new URL('http://example.com/api/notes/parent/videos')), true); }
    finally { mock?.mock.restore(); }
    assert.equal(status, item.status);
    assert.match(payload.error, item.pattern);
    assert.doesNotMatch(payload.error, /signature|0leoshare/);
    if (item.code) assert.ok(payload.error.includes(hostname));
  }
  const state = JSON.parse(await readFile(path.join(dataDir, 'notes.json'), 'utf8'));
  assert.equal(state.notes.length, 1);
  assert.deepEqual(state.videoJobs, []);
});
