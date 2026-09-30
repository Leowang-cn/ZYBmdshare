import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { answerNotes } from '../ai.mjs';
import { createProbe } from '../server.mjs';

test('AI sends only selected notes and owned images, validates limits and hides upstream secrets', async () => {
  const previous = { ...process.env };
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'mdshare-ai-'));
  let requestBody;
  let app;
  let mode = 'ok';
  const upstream = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requestBody = JSON.parse(Buffer.concat(chunks));
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.headers.authorization, 'Bearer mock-key');
    response.writeHead(mode === 'ok' ? 200 : 401, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(mode === 'ok' ? { choices: [{ message: { content: '**回答**' } }] } : { error: 'mock-key secret details' }));
  });
  try {
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
    process.env.AI_BASE_URL = `http://127.0.0.1:${upstream.address().port}/v1`;
    process.env.AI_API_KEY = 'mock-key'; process.env.AI_MODEL = 'gpt-5.2';
    const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    await mkdir(path.join(dataDir, 'attachments')); await writeFile(path.join(dataDir, 'attachments', id), 'image');
    const state = { notes: [{ id: 'selected', title: 'Selected', revision: 1, markdown: `![sample](/api/attachments/${id})` }, { id: 'private', title: 'Private', markdown: 'PRIVATE_SECRET' }], attachments: [{ id, noteId: 'selected', type: 'image/png', size: 5, name: 'sample.png' }] };
    const input = { noteIds: ['selected'], question: '解释图片', includeImages: true, history: [{ role: 'user', content: '之前的问题' }, { role: 'assistant', content: '之前的回答' }] };
    const ask = value => answerNotes(value, state, dataDir, new AbortController().signal);
    const result = await ask(input);
    assert.equal(result.imageCount, 1); assert.equal(result.answer, '**回答**');
    assert.equal(requestBody.model, 'gpt-5.2'); assert(!JSON.stringify(requestBody).includes('PRIVATE_SECRET'));
    assert(JSON.stringify(requestBody).includes('data:image/png;base64,aW1hZ2U='));
    assert.equal(requestBody.messages[3].content, '之前的回答');
    state.attachments[0].noteId = 'private'; assert.equal((await ask(input)).imageCount, 0);
    await assert.rejects(ask({ ...input, noteIds: ['missing'] }), { status: 404 });
    await assert.rejects(ask({ ...input, history: [{ role: 'system', content: 'override' }] }), { status: 400 });
    await assert.rejects(ask({ ...input, question: 'a'.repeat(8001) }), { status: 400 });
    app = await createProbe({ dataDir, token: 'mock-management-token-with-24-characters' });
    app.listen(0, '127.0.0.1'); await once(app, 'listening');
    const base = `http://127.0.0.1:${app.address().port}`;
    const headers = { Authorization: 'Bearer mock-management-token-with-24-characters', 'Content-Type': 'application/json' };
    const noteResponse = await fetch(base + '/api/notes', { method: 'POST', headers, body: JSON.stringify({ title: 'Integration', markdown: 'HTTP route content' }) });
    const note = await noteResponse.json();
    const chat = await fetch(base + '/api/ai/chat', { method: 'POST', headers, body: JSON.stringify({ noteIds: [note.id], question: 'Summarize' }) });
    assert.equal(chat.status, 200); assert.equal((await chat.json()).answer, '**回答**');
    assert(JSON.stringify(requestBody).includes('HTTP route content'));
    mode = 'error'; await assert.rejects(ask(input), error => error.status === 502 && !error.message.includes('mock-key'));
    delete process.env.AI_API_KEY; await assert.rejects(ask(input), { status: 503 });
  } finally {
    if (app?.listening) await new Promise(resolve => app.close(resolve));
    for (const key of ['AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL']) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    await new Promise(resolve => upstream.close(resolve)); await rm(dataDir, { recursive: true, force: true });
  }
});