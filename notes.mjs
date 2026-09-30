import { randomBytes, randomUUID, randomInt, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, stat, unlink, open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { ZipFile } from 'yazl';
import { answerNotes } from './ai.mjs';
import { checkUrl, extractVideoUrls, runVideoJob, videoTitleFromUrl } from './video.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const MAX_ATTACHMENT_BYTES = 512 * 1024 * 1024;
const equal = (actual, expected) => {
  const left = Buffer.from(typeof actual === 'string' ? actual : '');
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
};

export async function body(request, limit = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) fail(413, 'Request too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function jsonBody(request) {
  try { return JSON.parse((await body(request)).toString()); }
  catch (error) { if (error.status) throw error; fail(400, 'Invalid JSON'); }
}

export async function createNotes({ dataDir, token }) {
  const filename = path.join(dataDir, 'notes.json');
  let state = { version: 1, notes: [], shares: [], attachments: [] };
  try {
    state = JSON.parse(await readFile(filename, 'utf8'));
    if (state.version !== 1 || !Array.isArray(state.notes) || !Array.isArray(state.shares) || !Array.isArray(state.attachments)) throw new Error('Invalid notes database');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  state.videoJobs ??= [];
  if (!Array.isArray(state.videoJobs)) throw new Error('Invalid video jobs');
  for (const job of state.videoJobs) if (!['completed', 'failed'].includes(job.status)) { job.status = 'queued'; job.error = '服务已重启，任务继续处理'; }
  await mkdir(path.join(dataDir, 'attachments'), { recursive: true, mode: 0o700 });
  let pending = Promise.resolve();
  const mutate = callback => {
    const operation = pending.then(async () => {
      const next = structuredClone(state);
      const result = await callback(next);
      await writeFile(`${filename}.tmp`, JSON.stringify(next), { mode: 0o600 });
      await rename(`${filename}.tmp`, filename);
      state = next;
      return result;
    });
    pending = operation.catch(() => {});
    return operation;
  };
  const subtree = (database, rootId) => {
    const ids = new Set([rootId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const note of database.notes) if (ids.has(note.parentId) && !ids.has(note.id)) { ids.add(note.id); changed = true; }
    }
    return ids;
  };
  const getNote = (database, id) => database.notes.find(note => note.id === id) || fail(404, 'Note not found');
  const validate = (database, input, id) => {
    if (!input || typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200) fail(400, 'Title must contain 1-200 characters');
    if (typeof input.markdown !== 'string' || Buffer.byteLength(input.markdown) > 1024 * 1024) fail(400, 'Markdown must be a string of at most 1 MiB');
    const parentId = input.parentId ?? null;
    if (parentId !== null) {
      getNote(database, parentId);
      if (id && subtree(database, id).has(parentId)) fail(400, 'Cannot move a note into its own subtree');
    }
    return { title: input.title.trim(), markdown: input.markdown, parentId };
  };
  const addNote = (database, input) => {
    if (database.notes.length >= 10000) fail(409, 'Note limit reached');
    const note = { ...validate(database, input), id: randomUUID(), revision: 1, updatedAt: new Date().toISOString() };
    database.notes.push(note);
    return note;
  };
  const sessions = new Map();
  const videoConcurrency = Number(process.env.VIDEO_CONCURRENCY || 3);
  if (!Number.isInteger(videoConcurrency) || videoConcurrency < 1 || videoConcurrency > 10) throw new Error('VIDEO_CONCURRENCY 必须是 1-10 的整数');
  const claimedVideos = new Set();
  let videoRunning = false;
  const runVideos = async () => {
    if (videoRunning) return;
    videoRunning = true;
    try {
      await Promise.all(Array.from({ length: videoConcurrency }, async () => {
      let job;
      while ((job = state.videoJobs.find(item => item.status === 'queued' && !claimedVideos.has(item.id)))) {
        const current = job;
        claimedVideos.add(current.id);
        const staged = [];
        try {
          await runVideoJob(current, {
            dataDir,
            cachedAttachments: current.attachmentIds
              ? current.attachmentIds.map(id => state.attachments.find(item => item.id === id && item.noteId === current.noteId)).filter(Boolean)
              : state.attachments.filter(item => item.noteId === current.noteId),
            saveAttachment: async file => {
              const attachment = { id: randomUUID(), noteId: current.noteId, name: file.name, type: file.type, size: (await stat(file.path)).size };
              staged.push(attachment);
              await rename(file.path, path.join(dataDir, 'attachments', attachment.id));
              return { ...attachment, url: `/api/attachments/${attachment.id}` };
            },
            update: async ({ markdown, attachments, ...patch }) => {
              await mutate(database => {
                const record = database.videoJobs.find(item => item.id === current.id);
                if (!record) throw new Error('任务已删除');
                if (markdown !== undefined) {
                  const note = getNote(database, current.noteId);
                  if (note.revision !== current.revision) throw new Error('子笔记已被编辑，未覆盖正文；请重试');
                  validate(database, { ...note, markdown }, note.id);
                  note.markdown = markdown; note.revision += 1; note.updatedAt = new Date().toISOString();
                  database.attachments.push(...staged);
                  record.attachmentIds = attachments.map(item => item.id);
                }
                Object.assign(record, patch, { updatedAt: new Date().toISOString() });
              });
              if (patch.status === 'completed') staged.length = 0;
            }
          });
        } catch (error) {
          await mutate(database => { const record = database.videoJobs.find(item => item.id === current.id); if (record) { record.status = 'failed'; record.error = error instanceof Error ? error.message : '任务存储失败'; } });
        } finally {
          for (const attachment of staged) await unlink(path.join(dataDir, 'attachments', attachment.id)).catch(() => {});
          claimedVideos.delete(current.id);
        }
      }
      }));
    } finally { videoRunning = false; }
  };
  const attempts = new Map();
  const readers = new Map();
  const pinAttempts = new Map();
  let aiBusy = false;
  const pinHash = (id, pin) => createHmac('sha256', token).update(`${id}:${pin}`).digest('hex');
  const checkPin = pin => { if (typeof pin !== 'string' || !/^\d{4}$/.test(pin)) fail(400, 'PIN must contain four digits'); return pin; };
  const requireReader = (request, share) => {
    const cookie = (request.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(`mdshare_reader_${share.id}=`))?.split('=')[1];
    const reader = readers.get(digest(cookie || ''));
    if (!reader || reader.shareId !== share.id || reader.pinHash !== share.pinHash || reader.until <= Date.now()) fail(401, 'PIN required');
  };
  const publicShare = value => {
    const share = state.shares.find(item => item.hash === digest(value));
    if (!share || !state.notes.some(note => note.id === share.noteId)) fail(404, 'Share not found or revoked');
    return share;
  };
  void runVideos().catch(() => {});
  return async (request, response, url) => {
    const route = url.pathname;
    if (!route.startsWith('/api/notes') && !route.startsWith('/api/shares') && !route.startsWith('/api/public/') && !route.startsWith('/api/session') && !route.startsWith('/api/attachments/') && route !== '/api/export' && route !== '/api/ai/chat' && route !== '/api/videos' && route !== '/api/videos/regenerate') return false;
    const send = (status, value, headers = {}) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
      response.end(JSON.stringify(value));
    };
    try {
      if (/^\/api\/attachments\/[^/]+$/.test(route) && ['GET', 'HEAD'].includes(request.method)) {
        const attachment = state.attachments.find(item => item.id === route.split('/')[3]);
        if (!attachment) fail(404, 'Attachment not found');
        const secret = url.searchParams.get('share');
        if (secret) {
          const share = publicShare(secret);
          requireReader(request, share);
          if (!subtree(state, share.noteId).has(attachment.noteId)) fail(404, 'Attachment not found');
        } else {
          const cookie = /(?:^|;\s*)mdshare_session=([a-f0-9]{64})(?:;|$)/.exec(request.headers.cookie || '')?.[1];
          if (!equal(request.headers.authorization, `Bearer ${token}`) && !(sessions.get(digest(cookie || '')) > Date.now())) fail(401, 'Authentication required');
        }
        const location = path.join(dataDir, 'attachments', attachment.id);
        const { size } = await stat(location);
        const range = request.headers.range;
        let start = 0;
        let end = size - 1;
        if (range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(range);
          if (!match || (!match[1] && !match[2])) fail(416, 'Invalid range');
          if (!match[1]) start = Math.max(0, size - Number(match[2]));
          else { start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), size - 1) : end; }
          if (start > end || start >= size) fail(416, 'Invalid range');
        }
        response.writeHead(range ? 206 : 200, {
          'Content-Type': attachment.type,
          'Content-Length': end - start + 1,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(attachment.name).replace(/'/g, '%27')}`,
          ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {})
        });
        if (request.method === 'HEAD') response.end();
        else {
          const stream = createReadStream(location, { start, end });
          stream.on('error', () => response.destroy());
          response.on('close', () => stream.destroy());
          stream.pipe(response);
        }
        return true;
      }
      if (route.startsWith('/api/public/')) {
        const parts = route.split('/');
        const share = publicShare(parts[3]);
        if (parts.length === 5 && parts[4] === 'unlock' && request.method === 'POST') {
          if (request.headers.origin && new URL(request.headers.origin).host !== request.headers.host) fail(403, 'Cross-origin request denied');
          const now = Date.now();
          for (const [key, attempt] of pinAttempts) if (attempt.until <= now) pinAttempts.delete(key);
          const key = share.id;
          const attempt = pinAttempts.get(key) || { count: 0, until: now + 60000 };
          if (attempt.count >= 10) fail(429, '尝试过于频繁，请一分钟后重试');
          attempt.count += 1; pinAttempts.set(key, attempt);
          const input = await jsonBody(request);
          if (!share.pinHash || !equal(pinHash(share.id, checkPin(input?.pin)), share.pinHash)) fail(401, 'PIN 不正确或尚未设置');
          for (const [key, reader] of readers) if (reader.until <= now) readers.delete(key);
          if (readers.size >= 10000) readers.delete(readers.keys().next().value);
          const secret = randomBytes(32).toString('hex');
          readers.set(digest(secret), { shareId: share.id, pinHash: share.pinHash, until: now + 28800000 });
          send(200, { ok: true }, { 'Set-Cookie': `mdshare_reader_${share.id}=${secret}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${process.env.COOKIE_SECURE === '1' ? '; Secure' : ''}` });
          return true;
        }
        if (request.method !== 'GET') fail(405, 'Read-only share');
        const download = parts.length === 5 && parts[4] === 'download';
        if (parts.length !== 4 && !download) fail(404, 'Not found');
        requireReader(request, share);
        const ids = subtree(state, share.noteId);
        if (download) {
          const safeName = value => value.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 60) || 'note';
          const attachments = state.attachments.filter(item => ids.has(item.noteId));
          const images = attachments.filter(item => item.type.startsWith('image/'));
          for (const image of images) await stat(path.join(dataDir, 'attachments', image.id));
          const imagePaths = new Map(images.map(image => [image.id, `images/${image.id}-${safeName(image.name)}`]));
          const origin = `${request.socket.encrypted || process.env.COOKIE_SECURE === '1' ? 'https' : 'http'}://${request.headers.host}`;
          const archive = new ZipFile();
          archive.on('error', () => response.destroy());
          archive.outputStream.on('error', () => response.destroy());
          response.on('close', () => archive.outputStream.destroy());
          for (const note of state.notes.filter(item => ids.has(item.id))) {
            const markdown = note.markdown.replace(/(?<![\w:/.])\/api\/attachments\/([a-f0-9-]+)(?:\?[^\s)"'<>]*)?/g, (match, id) => {
              if (imagePaths.has(id)) return imagePaths.get(id);
              if (attachments.some(item => item.id === id)) return `${origin}/api/attachments/${id}?share=${parts[3]}`;
              return match;
            });
            archive.addBuffer(Buffer.from(markdown), `${safeName(note.title)}-${note.id}.md`);
          }
          for (const image of images) archive.addFile(path.join(dataDir, 'attachments', image.id), imagePaths.get(image.id));
          response.writeHead(200, {
            'Content-Type': 'application/zip', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
            'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(safeName(getNote(state, share.noteId).title)).replace(/'/g, '%27')}.zip`
          });
          archive.outputStream.pipe(response);
          archive.end();
          return true;
        }
        send(200, { rootId: share.noteId, notes: state.notes.filter(note => ids.has(note.id)).map(note => ({ ...note, parentId: note.id === share.noteId ? null : note.parentId })) });
        return true;
      }
      if (route === '/api/session' && request.method === 'POST') {
        const origin = request.headers.origin;
        if (origin && new URL(origin).host !== request.headers.host) fail(403, 'Cross-origin request denied');
        const now = Date.now();
        for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
        const address = request.socket.remoteAddress;
        const attempt = attempts.get(address) || { count: 0, until: now + 60000 };
        if (attempt.count >= 10) fail(429, 'Too many attempts; retry in one minute');
        attempt.count += 1;
        attempts.set(address, attempt);
        const input = await jsonBody(request);
        if (!equal(input?.token, token)) fail(401, 'Invalid access token');
        for (const [key, expiry] of sessions) if (expiry <= now) sessions.delete(key);
        if (sessions.size >= 100) sessions.delete(sessions.keys().next().value);
        const session = randomBytes(32).toString('hex');
        sessions.set(digest(session), now + 8 * 60 * 60 * 1000);
        send(200, { ok: true }, { 'Set-Cookie': `mdshare_session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${process.env.COOKIE_SECURE === '1' ? '; Secure' : ''}` });
        return true;
      }
      const bearer = equal(request.headers.authorization, `Bearer ${token}`);
      const cookie = /(?:^|;\s*)mdshare_session=([a-f0-9]{64})(?:;|$)/.exec(request.headers.cookie || '')?.[1];
      const sessionKey = digest(cookie || '');
      if (!bearer && !(sessions.get(sessionKey) > Date.now())) fail(401, 'Authentication required');
      if (!bearer && !['GET', 'HEAD'].includes(request.method)) {
        if (!request.headers.origin || new URL(request.headers.origin).host !== request.headers.host) fail(403, 'Cross-origin request denied');
      }
      if (route === '/api/videos' && request.method === 'GET') {
        send(200, { jobs: state.videoJobs.filter(job => state.notes.some(note => note.id === job.noteId)).map(job => ({ ...job, title: getNote(state, job.noteId).title })) });
      } else if (route === '/api/videos/regenerate' && request.method === 'POST') {
        const input = await jsonBody(request);
        if (!Array.isArray(input.noteIds) || !input.noteIds.length || input.noteIds.length > 30 || input.noteIds.some(id => typeof id !== 'string') || new Set(input.noteIds).size !== input.noteIds.length) fail(400, '请选择 1-30 篇视频笔记');
        const jobs = await mutate(database => {
          const targets = input.noteIds.map(id => {
            const note = getNote(database, id);
            const job = database.videoJobs.find(item => item.noteId === id) || fail(400, '所选笔记不是视频解析笔记');
            if (!['completed', 'failed'].includes(job.status)) fail(409, '所选笔记正在处理中');
            return { note, job };
          });
          if (database.videoJobs.filter(job => !['completed', 'failed'].includes(job.status)).length + targets.length > 30) fail(429, '最多同时排队 30 个视频');
          return targets.map(({ note, job }) => {
            job.revision = note.revision; job.status = 'queued'; job.progress = 0; delete job.error;
            return job;
          });
        });
        send(202, { jobs }); void runVideos().catch(() => {});
      } else if (/^\/api\/notes\/[^/]+\/videos$/.test(route)) {
        const parentId = route.split('/')[3];
        const parent = getNote(state, parentId);
        if (request.method === 'GET') send(200, { jobs: state.videoJobs.filter(job => job.parentId === parentId) });
        else if (request.method === 'POST') {
          const input = await jsonBody(request);
          const urls = input.urls ?? extractVideoUrls(parent.markdown);
          if (!Array.isArray(urls) || !urls.length || urls.length > 30 || urls.some(url => typeof url !== 'string')) fail(400, '需要 1-30 个视频 URL');
          try { for (const url of urls) await checkUrl(url); } catch { fail(400, '视频 URL 无效或指向内网、保留地址'); }
          const jobs = await mutate(database => {
            getNote(database, parentId);
            if (database.videoJobs.filter(job => !['completed', 'failed'].includes(job.status)).length + urls.length > 30) fail(429, '最多同时排队 30 个视频');
            if (database.videoJobs.length + urls.length > 1000) fail(409, '视频任务数量已达上限');
            return [...new Set(urls)].map((url, index) => {
              const note = addNote(database, { title: videoTitleFromUrl(url, `${parent.title.slice(0, 160)} - 视频 ${index + 1}`), parentId, markdown: '视频处理中。' });
              const job = { id: randomUUID(), parentId, noteId: note.id, revision: note.revision, url, status: 'queued', progress: 0, createdAt: new Date().toISOString() };
              database.videoJobs.push(job); return job;
            });
          });
          send(202, { jobs });
          void runVideos().catch(() => {});
        } else fail(405, 'Method not allowed');
      } else if (/^\/api\/notes\/[^/]+\/videos\/[^/]+\/retry$/.test(route) && request.method === 'POST') {
        await mutate(database => {
          const job = database.videoJobs.find(item => item.id === route.split('/')[5] && item.parentId === route.split('/')[3]) || fail(404, '任务不存在');
          if (job.status !== 'failed') fail(409, '只能重试失败任务');
          job.revision = getNote(database, job.noteId).revision;
          job.status = 'queued'; job.progress = 0; delete job.error;
        });
        send(202, { ok: true }); void runVideos().catch(() => {});
      } else if (route === '/api/ai/chat' && request.method === 'POST') {
        if (aiBusy) fail(429, '已有 AI 请求正在处理中，请稍后重试');
        aiBusy = true;
        const controller = new AbortController();
        const cancel = () => controller.abort();
        response.on('close', cancel);
        try { send(200, await answerNotes(await jsonBody(request), state, dataDir, controller.signal)); }
        finally { aiBusy = false; response.off('close', cancel); }
      } else if (/^\/api\/notes\/[^/]+\/attachments$/.test(route) && request.method === 'POST') {
        const noteId = route.split('/')[3];
        getNote(state, noteId);
        const type = (request.headers['content-type'] || '').split(';')[0];
        const allowed = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/mp4', 'video/mp4', 'video/webm', 'application/pdf'];
        if (!allowed.includes(type)) fail(415, 'Unsupported attachment type');
        const name = url.searchParams.get('name') || 'attachment';
        if (name.length > 200 || /[\x00-\x1f]/.test(name)) fail(400, 'Invalid filename');
        const attachment = { id: randomUUID(), noteId, name, type, size: 0 };
        const temporary = path.join(dataDir, 'attachments', `.upload-${attachment.id}`);
        let handle;
        try {
          if (Number(request.headers['content-length']) > MAX_ATTACHMENT_BYTES) fail(413, 'Attachment exceeds 512 MiB');
          handle = await open(temporary, 'wx', 0o600);
          for await (const chunk of request) {
            attachment.size += chunk.length;
            if (attachment.size > MAX_ATTACHMENT_BYTES) fail(413, 'Attachment exceeds 512 MiB');
            await handle.writeFile(chunk);
          }
          await handle.close();
          handle = null;
          if (!attachment.size) fail(400, 'Empty attachment');
          await mutate(async database => {
            getNote(database, noteId);
            await rename(temporary, path.join(dataDir, 'attachments', attachment.id));
            database.attachments.push(attachment);
          });
        } catch (error) {
          await handle?.close().catch(() => {});
          await unlink(temporary).catch(() => {});
          await unlink(path.join(dataDir, 'attachments', attachment.id)).catch(() => {});
          throw error;
        }
        send(201, { ...attachment, url: `/api/attachments/${attachment.id}` });
      } else if (route === '/api/session' && request.method === 'DELETE') {
        sessions.delete(sessionKey);
        send(200, { ok: true }, { 'Set-Cookie': 'mdshare_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
      } else if (route === '/api/export' && request.method === 'GET') {
        send(200, state, { 'Content-Disposition': 'attachment; filename="mdshare-backup.json"' });
      } else if (route === '/api/notes' && request.method === 'GET') {
        send(200, { notes: state.notes });
      } else if (route === '/api/notes' && request.method === 'POST') {
        const input = await jsonBody(request);
        send(201, await mutate(database => addNote(database, input)));
      } else if (route === '/api/notes/batch' && request.method === 'POST') {
        const input = await jsonBody(request);
        if (!Array.isArray(input?.notes) || !input.notes.length || input.notes.length > 100) fail(400, 'Provide 1-100 notes');
        send(201, await mutate(database => {
          const refs = new Map();
          return { notes: input.notes.map(item => {
            if (!item || typeof item !== 'object') fail(400, 'Invalid note');
            if (item.key !== undefined && (typeof item.key !== 'string' || !item.key || refs.has(item.key))) fail(400, 'Batch keys must be unique strings');
            if (item.parentKey !== undefined && !refs.has(item.parentKey)) fail(400, 'parentKey must reference an earlier note');
            const note = addNote(database, { ...item, parentId: item.parentKey === undefined ? item.parentId : refs.get(item.parentKey) });
            if (item.key !== undefined) refs.set(item.key, note.id);
            return note;
          }) };
        }));
      } else if (route === '/api/notes/batch' && request.method === 'PUT') {
        const input = await jsonBody(request);
        if (!Array.isArray(input?.notes) || !input.notes.length || input.notes.length > 100) fail(400, 'Provide 1-100 notes');
        send(200, await mutate(database => {
          const seen = new Set();
          return { notes: input.notes.map(item => {
            const note = getNote(database, item?.id);
            if (seen.has(note.id)) fail(400, 'Duplicate note');
            seen.add(note.id);
            if (item.revision !== note.revision) fail(409, 'Note changed; reload before saving');
            Object.assign(note, validate(database, item, note.id), { revision: note.revision + 1, updatedAt: new Date().toISOString() });
            return note;
          }) };
        }));
      } else if (/^\/api\/notes\/[^/]+$/.test(route)) {
        const id = route.split('/')[3];
        if (request.method === 'GET') send(200, getNote(state, id));
        else if (request.method === 'PUT') {
          const input = await jsonBody(request);
          send(200, await mutate(database => {
            const note = getNote(database, id);
            if (input?.revision !== note.revision) fail(409, 'Note changed; reload before saving');
            Object.assign(note, validate(database, input, id), { revision: note.revision + 1, updatedAt: new Date().toISOString() });
            return note;
          }));
        } else if (request.method === 'DELETE') {
          const input = await jsonBody(request);
          await mutate(database => {
            const note = getNote(database, id);
            if (input?.revision !== note.revision) fail(409, 'Note changed; reload before deleting');
            const ids = subtree(database, id);
            database.notes = database.notes.filter(item => !ids.has(item.id));
            database.shares = database.shares.filter(item => !ids.has(item.noteId));
            database.attachments = database.attachments.filter(item => !ids.has(item.noteId));
            database.videoJobs = database.videoJobs.filter(item => !ids.has(item.noteId) && !ids.has(item.parentId));
          });
          send(200, { ok: true });
        } else fail(405, 'Method not allowed');
      } else if (route === '/api/shares' && request.method === 'GET') {
        send(200, { shares: state.shares.map(({ hash, pinHash, ...share }) => ({ ...share, pinProtected: !!pinHash })) });
      } else if (route === '/api/shares' && request.method === 'POST') {
        const input = await jsonBody(request);
        const secret = randomBytes(32).toString('hex');
        const pin = input?.pin === undefined ? String(randomInt(10000)).padStart(4, '0') : checkPin(input.pin);
        const share = await mutate(database => {
          getNote(database, input?.noteId);
          if (database.shares.length >= 1000) fail(409, 'Share limit reached');
          const record = { id: randomUUID(), noteId: input.noteId, hash: digest(secret), createdAt: new Date().toISOString() };
          record.pinHash = pinHash(record.id, pin);
          database.shares.push(record);
          return record;
        });
        send(201, { id: share.id, url: `/s/${secret}`, pin });
      } else if (/^\/api\/shares\/[^/]+$/.test(route) && request.method === 'PUT') {
        const input = await jsonBody(request);
        const pin = checkPin(input?.pin);
        await mutate(database => {
          const share = database.shares.find(item => item.id === route.split('/')[3]) || fail(404, 'Share not found');
          share.pinHash = pinHash(share.id, pin);
        });
        for (const [key, reader] of readers) if (reader.shareId === route.split('/')[3]) readers.delete(key);
        send(200, { ok: true });
      } else if (/^\/api\/shares\/[^/]+$/.test(route) && request.method === 'DELETE') {
        await mutate(database => { database.shares = database.shares.filter(share => share.id !== route.split('/')[3]); });
        send(200, { ok: true });
      } else fail(404, 'Not found');
    } catch (error) { send(error.status || 500, { error: error.status ? error.message : 'Storage operation failed' }); }
    return true;
  };
}