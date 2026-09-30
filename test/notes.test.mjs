import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { promises as dns } from 'node:dns';
import { createProbe } from '../server.mjs';
import { unzipSync, strFromU8 } from 'fflate';

test('video queue runs three jobs concurrently without duplicate claims', async context => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'mdshare-concurrency-'));
  const token = 'test-token-with-at-least-24-characters';
  const previous = process.env.VIDEO_CONCURRENCY;
  delete process.env.VIDEO_CONCURRENCY;
  const releases = [];
  let active = 0;
  let maximum = 0;
  context.mock.method(dns, 'lookup', async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => releases.push(resolve));
    active -= 1;
    return [{ address: '127.0.0.1', family: 4 }];
  });
  const notes = Array.from({ length: 4 }, (_, index) => ({ id: `note-${index}`, title: '测试', markdown: '', revision: 1, parentId: null }));
  await writeFile(path.join(dataDir, 'notes.json'), JSON.stringify({ version: 1, notes, shares: [], attachments: [], videoJobs: notes.map(note => ({ id: note.id, noteId: note.id, status: 'queued', revision: 1, url: 'https://cache-test.example/video.mp4' })) }));
  const server = await createProbe({ dataDir, token });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const jobs = async () => (await (await fetch(`http://127.0.0.1:${server.address().port}/api/videos`, { headers: { Authorization: `Bearer ${token}` } })).json()).jobs;
  try {
    for (let attempt = 0; attempt < 100 && releases.length < 3; attempt++) await jobs();
    assert.equal(releases.length, 3);
    assert.equal((await jobs()).filter(job => job.status === 'queued').length, 1);
    releases[0]();
    for (let attempt = 0; attempt < 100 && releases.length < 4; attempt++) await jobs();
    assert.equal(releases.length, 4);
    releases.forEach(release => release());
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await jobs()).every(job => job.status === 'failed')) break;
      if (attempt === 99) assert.fail('queue did not finish');
    }
    assert.equal(maximum, 3);
    assert.equal(releases.length, 4);
  } finally {
    releases.forEach(release => release());
    if (previous === undefined) delete process.env.VIDEO_CONCURRENCY;
    else process.env.VIDEO_CONCURRENCY = previous;
    await new Promise(resolve => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('video regeneration is atomic and preserves existing note titles and content on failure', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'mdshare-regenerate-'));
  const token = 'test-token-with-at-least-24-characters';
  const note = { id: 'video-note', title: '自定义标题', markdown: '原正文', parentId: null, revision: 3 };
  await writeFile(path.join(dataDir, 'notes.json'), JSON.stringify({ version: 1, notes: [note, { ...note, id: 'ordinary' }], shares: [], attachments: [], videoJobs: [{ id: 'job', noteId: note.id, parentId: 'ordinary', url: 'http://127.0.0.1/video.mp4', status: 'completed', revision: 1 }] }));
  const server = await createProbe({ dataDir, token });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (route, value) => fetch(base + route, { method: value ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: value ? JSON.stringify(value) : undefined });
  try {
    assert.equal((await fetch(base + '/api/videos')).status, 401);
    assert.equal((await request('/api/videos/regenerate', { noteIds: ['video-note', 'ordinary'] })).status, 400);
    assert.equal((await (await request('/api/videos')).json()).jobs[0].status, 'completed');
    assert.equal((await request('/api/videos/regenerate', { noteIds: ['video-note', 'video-note'] })).status, 400);
    const response = await request('/api/videos/regenerate', { noteIds: ['video-note'] });
    assert.equal(response.status, 202);
    assert.equal((await response.json()).jobs[0].revision, 3);
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await (await request('/api/videos')).json()).jobs[0].status === 'failed') break;
      if (attempt === 99) assert.fail('job did not finish');
    }
    const preserved = await (await request('/api/notes/video-note')).json();
    assert.equal(preserved.title, note.title); assert.equal(preserved.markdown, note.markdown); assert.equal(preserved.revision, 3);
  } finally { await new Promise(resolve => server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); }
});

test('notes persist; batch is atomic; shares isolate subtrees and can be revoked', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'mdshare-notes-'));
  const token = 'test-token-with-at-least-24-characters';
  let server;
  let base;
  const start = async () => {
    server = await createProbe({ dataDir, token });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  };
  const api = async (route, method = 'GET', value) => {
    const response = await fetch(base + route, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: value === undefined ? undefined : JSON.stringify(value) });
    return { status: response.status, body: await response.json() };
  };
  try {
    await start();
    const assets = await readdir(new URL('../public/', import.meta.url)).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    for (const asset of assets.filter(name => name.endsWith('.js'))) assert.equal((await fetch(`${base}/${asset}`)).status, 200, asset);
    assert.equal((await fetch(base + '/api/notes')).status, 401);
    assert.equal((await fetch(base + '/api/ai/chat', { method: 'POST', body: '{}' })).status, 401);
    const batch = await api('/api/notes/batch', 'POST', { notes: [{ key: 'parent', title: 'Parent', markdown: '# Parent' }, { title: 'Child', parentKey: 'parent', markdown: 'Child' }, { title: 'Private', markdown: 'secret' }] });
    assert.equal(batch.status, 201);
    const [parent, child, privateNote] = batch.body.notes;
    assert.equal((await api('/api/notes/batch', 'POST', { notes: [{ title: 'Rollback', markdown: '' }, { title: '' }] })).status, 400);
    assert.equal((await api('/api/notes')).body.notes.length, 3);
    assert.equal((await api('/api/notes/batch', 'PUT', { notes: [{ ...child, title: 'Must roll back' }, { ...privateNote, revision: 0 }] })).status, 409);
    assert.equal((await api(`/api/notes/${child.id}`)).body.title, 'Child');
    assert.equal((await api('/api/notes/batch', 'PUT', { notes: [{ ...child, title: 'Updated child' }, { ...privateNote, title: 'Updated private' }] })).status, 200);
    assert.equal((await api(`/api/notes/${child.id}`)).body.revision, 2);
    assert.equal((await api(`/api/notes/${parent.id}`, 'PUT', { ...parent, parentId: child.id })).status, 400);
    assert.equal((await api(`/api/notes/${parent.id}`, 'PUT', { ...parent, revision: 0 })).status, 409);
    const shared = (await api('/api/shares', 'POST', { noteId: parent.id })).body;
    const publicRoute = '/api/public/' + shared.url.split('/').pop();
    assert.match(shared.pin, /^\d{4}$/);
    assert.equal((await fetch(base + publicRoute)).status, 401);
    assert.equal((await fetch(base + publicRoute + '/download')).status, 401);
    const unlock = pin => fetch(base + publicRoute + '/unlock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }) });
    assert.equal((await unlock(shared.pin === '0000' ? '0001' : '0000')).status, 401);
    let readerCookie = (await unlock(shared.pin)).headers.get('set-cookie').split(';')[0];
    const read = route => fetch(base + route, { headers: { Cookie: readerCookie } });
    const upload = async noteId => {
      const response = await fetch(`${base}/api/notes/${noteId}/attachments?name=sample.mp4`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'video/mp4' }, body: Buffer.from('0123456789') });
      assert.equal(response.status, 201);
      return response.json();
    };
    const attachment = await upload(child.id);
    const privateAttachment = await upload(privateNote.id);
    const imageResponse = await fetch(`${base}/api/notes/${child.id}/attachments?name=picture.png`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/png' }, body: Buffer.from('image-content') });
    const image = await imageResponse.json();
    const currentChild = (await api(`/api/notes/${child.id}`)).body;
    assert.equal((await api(`/api/notes/${child.id}`, 'PUT', { ...currentChild, markdown: `![图片](${image.url})\n<video controls src="${attachment.url}"></video>\n<audio src="https://example.com/audio.mp3"></audio>` })).status, 200);
    const zipResponse = await read(publicRoute + '/download');
    assert.equal(zipResponse.status, 200);
    assert.equal(zipResponse.headers.get('content-type'), 'application/zip');
    const files = unzipSync(new Uint8Array(await zipResponse.arrayBuffer()));
    assert.equal(Object.keys(files).length, 3);
    assert.equal(strFromU8(files[`images/${image.id}-picture.png`]), 'image-content');
    const exported = strFromU8(files[`Updated child-${child.id}.md`]);
    assert.ok(exported.includes(`images/${image.id}-picture.png`));
    assert.ok(exported.includes(`${base}${attachment.url}?share=${shared.url.split('/').pop()}`));
    assert.ok(exported.includes('https://example.com/audio.mp3'));
    assert.ok(!Object.keys(files).some(name => name.includes(privateNote.id) || name.endsWith('.mp4')));
    const shareQuery = '?share=' + shared.url.split('/').pop();
    assert.equal((await fetch(base + attachment.url)).status, 401);
    assert.equal((await fetch(base + attachment.url + shareQuery)).status, 401);
    assert.equal((await read(privateAttachment.url + shareQuery)).status, 404);
    const range = await fetch(base + attachment.url + shareQuery, { headers: { Range: 'bytes=2-5', Cookie: readerCookie } });
    assert.equal(range.status, 206);
    assert.equal(await range.text(), '2345');
    const publicNotes = await (await read(publicRoute)).json();
    assert.deepEqual(publicNotes.notes.map(note => note.id), [parent.id, child.id]);
    assert.equal((await fetch(base + publicRoute + '/' + privateNote.id)).status, 404);
    assert.equal((await fetch(base + publicRoute, { method: 'POST' })).status, 405);
    await new Promise(resolve => server.close(resolve));
    await start();
    assert.equal((await api('/api/notes')).body.notes.length, 3);
    assert.equal((await read(publicRoute)).status, 401);
    readerCookie = (await unlock(shared.pin)).headers.get('set-cookie').split(';')[0];
    assert.equal((await read(publicRoute)).status, 200);
    assert.equal((await api(`/api/shares/${shared.id}`, 'PUT', { pin: '0382' })).status, 200);
    assert.equal((await read(publicRoute)).status, 401);
    assert.equal((await read(attachment.url + shareQuery)).status, 401);
    assert.equal((await read(publicRoute + '/download')).status, 401);
    readerCookie = (await unlock('0382')).headers.get('set-cookie').split(';')[0];
    assert.equal((await read(publicRoute)).status, 200);
    assert.equal((await fetch(base + '/api/notes', { headers: { Cookie: readerCookie } })).status, 401);
    assert.equal((await fetch(base + '/api/ai/chat', { method: 'POST', headers: { Cookie: readerCookie }, body: '{}' })).status, 401);
    for (let attempt = 0; attempt < 10; attempt++) await unlock('9999');
    assert.equal((await unlock('0382')).status, 429);
    await api(`/api/shares/${shared.id}`, 'DELETE');
    assert.equal((await fetch(base + publicRoute)).status, 404);
    assert.equal((await read(publicRoute + '/download')).status, 404);
    assert.equal((await fetch(base + attachment.url + shareQuery)).status, 404);
    const login = await fetch(base + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ token }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(base + '/api/notes', { headers: { Cookie: cookie } })).status, 200);
    assert.equal((await fetch(base + '/api/notes', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://other.example' }, body: '{}' })).status, 403);
    assert.equal((await fetch(base + '/api/ai/chat', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://other.example' }, body: '{}' })).status, 403);
    assert.equal((await api(`/api/notes/${parent.id}`, 'DELETE', { revision: parent.revision })).status, 200);
    assert.deepEqual((await api('/api/notes')).body.notes.map(note => note.id), [privateNote.id]);
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});