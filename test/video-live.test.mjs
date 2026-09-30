import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProbe } from '../server.mjs';

for (const model of ['whisper-1', 'qwen3-asr-flash-2025-09-08']) test(`public video URL becomes a child note with media attachments (${model})`, {
  skip: process.env.VIDEO_LIVE_TEST !== '1' && 'Set VIDEO_LIVE_TEST=1 to run external download test',
  timeout: 120000
}, async context => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'mdshare-video-live-'));
  const token = 'video-live-test-token-123456789';
  const calls = { asr: 0, summary: 0 };
  let asrUpload;
  let asrAuthorization;
  let qwenRequest;
  const ai = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    if (request.url === '/audio/transcriptions') {
      asrAuthorization = request.headers.authorization;
      asrUpload = await new Response(Buffer.concat(chunks), { headers: { 'Content-Type': request.headers['content-type'] } }).formData();
    }
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/chat/completions' && JSON.parse(Buffer.concat(chunks).toString()).model === 'qwen3-asr-flash-2025-09-08') {
      qwenRequest = JSON.parse(Buffer.concat(chunks).toString());
      asrAuthorization = request.headers.authorization;
      calls.asr += 1;
      response.end(JSON.stringify({ choices: [{ message: { content: '测试视频逐字稿' } }] }));
      return;
    }
    if (request.url === '/audio/transcriptions') { calls.asr += 1; response.end(JSON.stringify({ segments: [{ start: 0, end: 2, text: '测试视频逐字稿' }] })); }
    else if (request.url === '/chat/completions') { calls.summary += 1; response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: '测试视频总结', keyframes: [{ time: 1, reason: '画面样例', description: '这一段介绍视频的主要内容。' }] }) } }] })); }
    else { response.statusCode = 404; response.end('{}'); }
  });
  let app;
  const original = Object.fromEntries(['ASR_MODEL', 'ASR_BASE_URL', 'ASR_API_KEY', 'SUMMARY_BASE_URL', 'SUMMARY_API_KEY', 'AI_BASE_URL', 'AI_API_KEY', 'SUMMARY_MODEL'].map(key => [key, process.env[key]]));
  context.after(async () => {
    if (app?.listening) await new Promise(resolve => app.close(resolve));
    if (ai.listening) await new Promise(resolve => ai.close(resolve));
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(dataDir, { recursive: true, force: true });
  });
  ai.listen(0, '127.0.0.1');
  await once(ai, 'listening');
  const baseAI = `http://127.0.0.1:${ai.address().port}`;
  Object.assign(process.env, { ASR_BASE_URL: baseAI, ASR_API_KEY: 'test-only', SUMMARY_BASE_URL: baseAI, SUMMARY_API_KEY: 'test-only', AI_BASE_URL: baseAI, AI_API_KEY: 'test-only' });
  delete process.env.ASR_API_KEY;
  process.env.ASR_MODEL = model;
  process.env.SUMMARY_MODEL = 'test-summary';
  app = await createProbe({ dataDir, token });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  const base = `http://127.0.0.1:${app.address().port}`;
  const api = async (route, method = 'GET', body) => {
    const response = await fetch(base + route, {
      method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const result = await response.json();
    assert.ok(response.ok, `${route}: ${response.status} ${JSON.stringify(result)}`);
    return result;
  };
  const parent = await api('/api/notes', 'POST', { title: '视频测试', markdown: '', parentId: null });
  const url = 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4';
  const { jobs } = await api(`/api/notes/${parent.id}/videos`, 'POST', { urls: [url] });
  assert.equal(jobs.length, 1);
  let job;
  const deadline = Date.now() + 90000;
  do {
    ({ jobs: [job] } = await api(`/api/notes/${parent.id}/videos`));
    if (['completed', 'failed'].includes(job.status)) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  } while (Date.now() < deadline);
  assert.equal(job.status, 'completed', `video task ended: ${job.status}, ${job.error || ''}`);
  assert.equal(job.progress, 100);
  assert.ok(job.bytes > 0);
  assert.ok(job.duration > 0);
  assert.deepEqual(calls, { asr: 1, summary: 1 });
  assert.equal(asrAuthorization, 'Bearer test-only');
  if (model === 'whisper-1') {
    assert.equal(asrUpload.get('file').name, 'audio.mp3');
    assert.equal(asrUpload.get('file').type, 'audio/mpeg');
    assert.ok(asrUpload.get('file').size > 0);
  } else {
    assert.equal(qwenRequest.stream, false);
    assert.equal(qwenRequest.asr_options.enable_itn, false);
    assert.equal(qwenRequest.messages[0].content[0].type, 'input_audio');
    assert.match(qwenRequest.messages[0].content[0].input_audio.data, /^data:audio\/mp3;base64,[A-Za-z0-9+/=]+$/);
  }
  const child = await api(`/api/notes/${job.noteId}`);
  assert.equal(child.parentId, parent.id);
  assert.match(child.markdown, /测试视频总结/);
  if (model === 'whisper-1') assert.match(child.markdown, /\[00:00:00-00:00:02\] 测试视频逐字稿/);
  else assert.match(child.markdown, /（以下时间为音频切片范围，不是逐句时间戳）\n\n\[00:00:00-00:00:\d{2}\] 测试视频逐字稿/);
  assert.deepEqual([...child.markdown.matchAll(/^## (.+)$/gm)].map(match => match[1]), ['原视频：', '核心总结：', '图文描述：', '带时间戳逐字稿：', '音频：']);
  assert.match(child.markdown, /## 图文描述：\n\n### 00:00:01\n\n这一段介绍视频的主要内容。\n\n!\[关键帧\]\(\/api\/attachments\/[\w-]+\)\n\n## 带时间戳逐字稿：/);
  const attachments = [...child.markdown.matchAll(/\/api\/attachments\/[\w-]+/g)].map(match => match[0]);
  assert.equal(attachments.length, 3, 'video, audio, and one keyframe');
  for (const [index, attachment] of attachments.entries()) {
    const response = await fetch(base + attachment, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    assert.ok(Number(response.headers.get('content-length')) > 0);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.length, Number(response.headers.get('content-length')));
    if (index === 0) assert.equal(bytes.toString('ascii', 4, 8), 'ftyp');
    if (index === 1) assert.equal(bytes.subarray(0, 3).toString('hex'), 'ffd8ff');
    if (index === 2) assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  }
});