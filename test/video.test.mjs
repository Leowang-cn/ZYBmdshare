import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as dns } from 'node:dns';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { checkUrl, download, extractVideoUrls, findVideoCache, formatTranscript, isPrivateAddress, MAX_VIDEO_BYTES, MAX_VIDEO_SECONDS, parseTranscription, renderMindmap, runVideoJob, validateMindmap, videoTitleFromUrl } from '../video.mjs';

test('regeneration reuses media and real timestamps, and falls back only when missing', async context => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mdshare-cache-'));
  const originalEnvironment = { ...process.env };
  context.after(async () => {
    for (const key of ['SUMMARY_BASE_URL', 'SUMMARY_API_KEY', 'ASR_BASE_URL', 'ASR_API_KEY', 'ASR_MODEL']) {
      if (originalEnvironment[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnvironment[key];
    }
    await rm(directory, { recursive: true, force: true });
  });
  Object.assign(process.env, { SUMMARY_BASE_URL: 'https://model.example', SUMMARY_API_KEY: 'test', ASR_BASE_URL: 'https://model.example', ASR_API_KEY: 'test', ASR_MODEL: 'whisper-1' });
  const folder = path.join(directory, 'attachments');
  await mkdir(folder);
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=160x90:d=1', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '1', '-c:v', 'mpeg4', '-c:a', 'aac', '-f', 'mp4', path.join(folder, 'video')]);
  const timestamps = { version: 1, duration: 1, segments: [{ start: 0, end: 0.9, text: '测试内容' }], words: [] };
  await writeFile(path.join(folder, 'transcript'), JSON.stringify(timestamps));
  const video = { id: 'video', name: 'video', type: 'video/mp4' };
  const transcript = { id: 'transcript', name: 'transcription.json', type: 'application/json' };
  const calls = [];
  context.mock.method(globalThis, 'fetch', async url => {
    calls.push(url);
    return new Response(JSON.stringify(url.endsWith('/audio/transcriptions') ? timestamps : { choices: [{ message: { content: JSON.stringify({ summary: '总结', mindmap: { label: '要点', time: 0.2 } }) } }] }));
  });
  const run = async cachedAttachments => {
    const updates = [];
    const saved = [];
    await runVideoJob({ id: 'cache-test', url: 'http://127.0.0.1/unavailable.mp4' }, {
      dataDir: directory, cachedAttachments,
      update: async patch => { updates.push(patch); },
      saveAttachment: async file => { saved.push(file); return { id: file.name, url: `/api/attachments/${file.name}` }; }
    });
    return { updates, saved, last: updates.at(-1) };
  };
  const cached = await run([video, transcript]);
  assert.equal(cached.last.status, 'completed', cached.last.error);
  assert.deepEqual(calls, ['https://model.example/chat/completions']);
  assert.equal(cached.saved.some(item => ['video', 'transcription.json'].includes(item.name)), false);
  assert.equal(cached.updates.some(item => item.status === 'downloading'), false);
  assert.match(cached.last.markdown, /\/api\/attachments\/video/);
  assert.ok((await readFile(path.join(folder, 'video'))).length);
  calls.length = 0;
  await writeFile(path.join(folder, 'transcript'), JSON.stringify({ text: '旧版无时间戳' }));
  assert.equal((await findVideoCache(directory, [video, transcript])).transcription, undefined);
  const legacy = await run([video, transcript]);
  assert.equal(legacy.last.status, 'completed', legacy.last.error);
  assert.deepEqual(calls, ['https://model.example/audio/transcriptions', 'https://model.example/chat/completions']);
  assert.equal(legacy.saved.some(item => item.name === 'video'), false);
  await rm(path.join(folder, 'video'));
  calls.length = 0;
  const missing = await run([video, transcript]);
  assert.equal(missing.last.status, 'failed');
  assert.ok(missing.updates.some(item => item.status === 'downloading'));
  assert.deepEqual(calls, []);
});

test('mindmap embeds one image per leaf and rejects invalid capture times', () => {
  const tree = validateMindmap({ label: '主题', children: [{ label: '<要点>', time: 1 }, { label: '分支', children: [{ label: '末节点', time: 4 }] }] }, 5);
  const html = renderMindmap(tree, [{ url: '/api/attachments/first' }, { url: '/api/attachments/second' }]);
  assert.equal((html.match(/<img /g) || []).length, 2);
  assert.match(html, /&lt;要点&gt;/);
  assert.ok(html.indexOf('/first') < html.indexOf('/second'));
  for (const time of [-1, 5, NaN, undefined]) assert.throws(() => validateMindmap({ label: '无效', time }, 5));
});

test('transcriptions preserve model timestamps and reject missing or invalid timing', () => {
  const result = parseTranscription({ segments: [{ start: 0.12, end: 3.45, text: ' 第一段。 ' }, { start: 4.5, end: 8.9, text: '第二段。' }], words: [{ start: 0.12, end: 0.8, word: '第一段' }] });
  assert.equal(formatTranscript(result), '[00:00:00.120-00:00:03.450] 第一段。\n\n[00:00:04.500-00:00:08.900] 第二段。');
  assert.deepEqual(result.words, [{ start: 0.12, end: 0.8, word: '第一段' }]);
  for (const invalid of [{ text: '没有时间戳' }, { segments: [] }, { segments: [{ start: -1, end: 2, text: '错误' }] }, { segments: [{ start: 2, end: 1, text: '错误' }] }, { segments: [{ start: '0', end: 1, text: '错误' }] }]) assert.throws(() => parseTranscription(invalid), /ASR/);
});

test('video duration limit is twenty minutes', () => {
  assert.equal(MAX_VIDEO_SECONDS, 20 * 60);
});

test('video URL extraction accepts thirty unique URLs per batch', () => {
  const urls = Array.from({ length: 31 }, (_, index) => `https://example.com/${index}.mp4`);
  assert.deepEqual(extractVideoUrls(urls.slice(0, 30).join('\n')), urls.slice(0, 30));
  assert.deepEqual(extractVideoUrls(urls.join('\n')), urls.slice(0, 30));
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
