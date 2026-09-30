import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as dns } from 'node:dns';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkUrl, download, extractVideoUrls, isPrivateAddress, MAX_VIDEO_BYTES, MAX_VIDEO_SECONDS, videoTitleFromUrl } from '../video.mjs';

test('video duration limit is twenty minutes', () => {
  assert.equal(MAX_VIDEO_SECONDS, 20 * 60);
});

test('video note titles use decoded URL filenames without media extensions', () => {
  const fallback = '父笔记 - 视频 1';
  for (const [url, expected] of [
    ['https://example.com/folder/flower.mp4?token=secret#play', 'flower'],
    ['https://example.com/%E8%AF%AD%E6%96%87%20%E8%AF%BE%E7%A8%8B.WEBM', '语文 课程'],
    ['https://example.com/1cdb8725557d352b051df8511f1db1dd.mp4', '1cdb8725557d352b051df8511f1db1dd'],
    ['https://example.com/lesson.part.1.mp4', 'lesson.part.1'],
    ['https://example.com/bad%ZZ.mp4', 'bad%ZZ'],
    ['https://example.com/%00lesson%0A.mp4', 'lesson'],
    ['https://example.com/', fallback],
    ['https://example.com/folder/?name=lesson.mp4', fallback],
    ['https://example.com/.mp4', fallback],
    ['invalid', fallback],
    [`https://example.com/${'a'.repeat(220)}.mp4`, 'a'.repeat(200)]
  ]) assert.equal(videoTitleFromUrl(url, fallback), expected);
});

test('video URL extraction and address policy reject unsafe targets', async () => {
  assert.deepEqual(extractVideoUrls('a https://example.com/a.mp4, https://example.com/a.mp4\nhttps://example.com/b.webm'), ['https://example.com/a.mp4', 'https://example.com/b.webm']);
  for (const address of ['0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.1.1', '172.31.0.1', '192.0.2.1', '192.168.1.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '::', '::1', 'fc00::1', 'fe80::1', 'ff02::1', '2001:db8::1', '2002::1', '::ffff:127.0.0.1', '::ffff:7f00:1']) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of ['8.8.8.8', '198.51.99.1', '203.0.114.1', '2606:4700:4700::1111']) assert.equal(isPrivateAddress(address), false, address);
  await assert.rejects(checkUrl('file:///tmp/video.mp4'), /HTTP\(S\)/);
  await assert.rejects(checkUrl('http://user:pass@example.com/video.mp4'), /HTTP\(S\)/);
  await assert.rejects(checkUrl('http://127.0.0.1/video.mp4'), /内网/);
});

test('video URL validation blocks local targets', async () => {
  await assert.rejects(checkUrl('http://localhost/video.mp4'), /本机地址/);
  await assert.rejects(checkUrl('http://127.0.0.1/video.mp4'), /内网/);
});

test('video downloads pin DNS, revalidate redirects and reject oversized responses', async context => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mdshare-download-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const resolutions = [];
  context.mock.method(dns, 'lookup', async hostname => {
    resolutions.push(hostname);
    return [{ address: hostname === 'private.example' ? '127.0.0.1' : '8.8.8.8', family: 4 }];
  });
  let responses = [];
  let requests = 0;
  context.mock.method(http, 'get', (url, options, callback) => {
    requests += 1;
    options.lookup(url.hostname, { all: true }, (error, addresses) => {
      assert.equal(error, null);
      assert.deepEqual(addresses, [{ address: '8.8.8.8', family: 4 }]);
    });
    options.lookup(url.hostname, {}, (error, address, family) => {
      assert.equal(error, null);
      assert.equal(address, '8.8.8.8');
      assert.equal(family, 4);
    });
    const next = responses.shift();
    assert.ok(next, 'unexpected HTTP request');
    const response = Readable.from(next.body || []);
    response.statusCode = next.status || 200;
    response.headers = next.headers || {};
    queueMicrotask(() => callback(response));
    return new EventEmitter();
  });

  responses = [{ status: 302, headers: { location: 'http://private.example/video' } }];
  await assert.rejects(download('http://public.example/video', path.join(directory, 'private')), /内网/);
  assert.equal(requests, 1);
  assert.deepEqual(resolutions, ['public.example', 'private.example']);

  responses = [{ status: 302, headers: { location: 'file:///tmp/video' } }];
  await assert.rejects(download('http://public.example/video', path.join(directory, 'protocol')), /HTTP\(S\)/);

  responses = [{ status: 302, headers: { location: '/final' } }, { body: [Buffer.from('video')] }];
  const result = await download('http://public.example/video', path.join(directory, 'complete'));
  assert.deepEqual(result, { size: 5, url: 'http://public.example/final' });
  assert.equal(await readFile(path.join(directory, 'complete'), 'utf8'), 'video');

  responses = [{ headers: { 'content-length': String(MAX_VIDEO_BYTES + 1) } }];
  await assert.rejects(download('http://public.example/large', path.join(directory, 'large')), /512 MiB/);
  responses = [{}];
  await assert.rejects(download('http://public.example/empty', path.join(directory, 'empty')), /文件为空/);
  responses = Array.from({ length: 4 }, () => ({ status: 302, headers: { location: '/loop' } }));
  await assert.rejects(download('http://public.example/loop', path.join(directory, 'loop')), /重定向次数/);
  assert.equal(responses.length, 0);
});
