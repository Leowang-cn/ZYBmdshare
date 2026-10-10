import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { promises as dns } from 'node:dns';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

export const MAX_MEDIA_BYTES = 512 * 1024 * 1024;
export const MAX_VIDEO_BYTES = MAX_MEDIA_BYTES;
export const MAX_VIDEO_SECONDS = 1200;
export const MAX_AUDIO_SECONDS = 7200;
export const ASR_CHUNK_SECONDS = 20 * 60;
const MAX_REDIRECTS = 3;
const MAX_URLS_PER_JOB = 30;
const blockedAddresses = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 3]
]) blockedAddresses.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]
]) blockedAddresses.addSubnet(network, prefix, 'ipv6');
const globalIpv6 = new BlockList();
globalIpv6.addSubnet('2000::', 3, 'ipv6');
export const isPrivateAddress = address => {
  const family = isIP(address);
  if (family === 4) return blockedAddresses.check(address, 'ipv4');
  if (family !== 6 || address.includes('%')) return true;
  return !globalIpv6.check(address, 'ipv6') || blockedAddresses.check(address, 'ipv6');
};
export function parseMediaPrivateHostAllowlist(value = '{}') {
  const invalid = reason => { throw new Error(`Invalid MEDIA_PRIVATE_HOST_ALLOWLIST: ${reason}`); };
  let entries;
  try { entries = JSON.parse(value); } catch { invalid('expected a JSON object mapping exact hostnames to IP address arrays'); }
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) invalid('expected a JSON object');
  const allowlist = new Map();
  for (const [hostname, addresses] of Object.entries(entries)) {
    if (hostname.length > 253 || !hostname.includes('.') || !hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) || isIP(hostname) || hostname.endsWith('.localhost') || hostname.endsWith('.local')) invalid('keys must be exact lowercase DNS hostnames, not IP literals, URLs or wildcards');
    // URL parsing also catches non-standard numeric IP spellings such as 127.1.
    let parsedHostname;
    try { parsedHostname = new URL(`http://${hostname}`).hostname; } catch { invalid('invalid DNS hostname'); }
    if (parsedHostname !== hostname) invalid('IP literal hostname keys are not allowed');
    if (!Array.isArray(addresses) || !addresses.length) invalid('each hostname must map to a non-empty IP address array');
    for (const address of addresses) {
      if (typeof address !== 'string' || !isIP(address) || address.includes('%') || !isPrivateAddress(address)) invalid('addresses must be exact private/reserved IP literals, not public addresses or CIDRs');
    }
    allowlist.set(hostname, new Set(addresses));
  }
  return allowlist;
}
const mediaPrivateHostAllowlist = parseMediaPrivateHostAllowlist(process.env.MEDIA_PRIVATE_HOST_ALLOWLIST);
export class MediaUrlError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.name = 'MediaUrlError';
    this.code = code;
    this.status = status;
  }
}
const publicHost = async (hostname, diagnostics) => {
  if (diagnostics) {
    diagnostics.hostname = hostname;
    diagnostics.allowlistMatched = mediaPrivateHostAllowlist.has(hostname);
  }
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) throw new MediaUrlError('音频/视频 URL 不允许访问本机地址，请使用公网地址', 'MEDIA_URL_PRIVATE_ADDRESS');
  if (isIP(hostname) && isPrivateAddress(hostname)) throw new MediaUrlError('音频/视频 URL 不允许访问内网或保留地址，请使用公网地址', 'MEDIA_URL_PRIVATE_ADDRESS');
  let records;
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
    if (!records.length) throw Object.assign(new Error(), { code: 'ENODATA' });
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : 'UNKNOWN';
    throw new MediaUrlError(`音频/视频 URL DNS 解析失败（${code}，主机：${hostname}）；请检查服务端 DNS 和网络，稍后重试`, 'MEDIA_URL_DNS_LOOKUP_FAILED', code === 'EAI_AGAIN' ? 503 : 502);
  }
  if (diagnostics) diagnostics.records = records.map(({ address, family }) => ({
    address, family, private: isPrivateAddress(address),
    allowed: !isPrivateAddress(address) || !!mediaPrivateHostAllowlist.get(hostname)?.has(address)
  }));
  if (records.some(({ address }) => isPrivateAddress(address) && !mediaPrivateHostAllowlist.get(hostname)?.has(address))) throw new MediaUrlError('音频/视频 URL 不允许访问内网或保留地址（包括混合公网/内网 DNS 结果），请使用仅解析到公网的地址', 'MEDIA_URL_PRIVATE_ADDRESS');
  return records[0];
};
const validateMediaUrl = async (value, diagnostics) => {
  let url;
  if (typeof value !== 'string') throw new MediaUrlError('音频/视频 URL 无效，请提供有效的 HTTP(S) 地址', 'MEDIA_URL_INVALID');
  try { url = new URL(value); } catch { throw new MediaUrlError('音频/视频 URL 无效，请提供有效的 HTTP(S) 地址', 'MEDIA_URL_INVALID'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new MediaUrlError('音频/视频 URL 必须是无认证的 HTTP(S) 地址', 'MEDIA_URL_INVALID');
  if (value.length > 4096) throw new MediaUrlError('音频/视频 URL 过长（最多 4096 字符）', 'MEDIA_URL_INVALID');
  const address = await publicHost(url.hostname.replace(/^\[|\]$/g, ''), diagnostics);
  return { url, address };
};
export const checkUrl = value => validateMediaUrl(value);
export async function diagnoseMediaUrl(value) {
  const diagnostics = { hostname: null, records: [], allowlistMatched: false, address: null };
  try {
    const { address } = await validateMediaUrl(value, diagnostics);
    return { ...diagnostics, address, ok: true, status: 200, code: 'MEDIA_URL_ALLOWED', message: '服务端 URL 校验通过；未下载媒体或检查重定向、格式与可用性' };
  } catch (error) {
    const safe = error instanceof MediaUrlError;
    return { ...diagnostics, ok: false, status: safe ? error.status : 500, code: safe ? error.code : 'MEDIA_URL_CHECK_FAILED', message: safe ? error.message : '音频/视频 URL 校验失败，请稍后重试或联系管理员' };
  }
}
export function mediaTitleFromUrl(value, fallback) {
  let filename;
  try {
    filename = new URL(value).pathname.split('/').pop();
  } catch { return fallback; }
  try { filename = decodeURIComponent(filename); } catch {}
  const title = filename.replace(/[\u0000-\u001f\u007f]/g, '').trim().replace(/\.(mp4|webm|mp3|m4a|m3a|aac|wav|flac|ogg|opus|wma)$/i, '').trim();
  return title && !/^\.+$/.test(title) ? [...title].slice(0, 200).join('') : fallback;
}
export const videoTitleFromUrl = mediaTitleFromUrl;
export function extractVideoUrls(markdown) {
  const urls = [...String(markdown || '').matchAll(/https?:\/\/[^\s<>"'`()\[\]]+/g)].map(match => match[0].replace(/[),.;!?]+$/, ''));
  return [...new Set(urls)].slice(0, MAX_URLS_PER_JOB);
}
function command(program, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000, killSignal: 'SIGKILL', ...options });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-1000000); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error('媒体处理失败或超时，请检查 FFmpeg 和媒体格式')));
  });
}
export async function download(url, destination) {
  let current = await checkUrl(url);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const response = await new Promise((resolve, reject) => {
      const request = (current.url.protocol === 'https:' ? https : http).get(current.url, {
        signal: AbortSignal.timeout(10 * 60 * 1000),
        lookup: (_host, options, callback) => options.all ? callback(null, [current.address]) : callback(null, current.address.address, current.address.family)
      }, resolve);
      request.on('error', reject);
    });
    if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
      response.destroy();
      if (redirect === MAX_REDIRECTS) throw new Error('视频 URL 重定向次数过多');
      current = await checkUrl(new URL(response.headers.location, current.url).href);
      continue;
    }
    if (response.statusCode !== 200) { response.destroy(); throw new Error(`视频下载失败（HTTP ${response.statusCode}）`); }
    const declared = Number(response.headers['content-length'] || 0);
    if (declared > MAX_VIDEO_BYTES) { response.destroy(); throw new Error('视频超过 512 MiB 限制'); }
    const handle = await open(destination, 'wx', 0o600);
    let size = 0;
    try {
      for await (const value of response) {
        size += value.byteLength;
        if (size > MAX_VIDEO_BYTES) throw new Error('视频超过 512 MiB 限制');
        await handle.writeFile(value);
      }
      await handle.close();
      if (!size) throw new Error('视频文件为空');
      return { size, url: current.url.href };
    } catch (error) {
      response.destroy();
      await handle.close().catch(() => {});
      throw error;
    }
  }
  throw new Error('视频下载失败');
}
export async function probeMedia(file) {
  const { stdout } = await command(process.env.FFPROBE_BIN || 'ffprobe', ['-v', 'error', '-protocol_whitelist', 'file', '-show_entries', 'format=duration,format_name:stream=codec_type,codec_name:stream_disposition=attached_pic', '-of', 'json', file]);
  const parsed = JSON.parse(stdout);
  const streams = parsed.streams || [];
  const hasAudio = streams.some(stream => stream.codec_type === 'audio');
  const hasRealVideo = streams.some(stream => stream.codec_type === 'video' && Number(stream.disposition?.attached_pic || 0) !== 1);
  if (!hasAudio && !hasRealVideo) throw new Error('文件没有可处理的音频或视频轨道');
  const info = parsed.format || {};
  const formatName = info.format_name || '';
  const kind = hasRealVideo ? 'video' : 'audio';
  if (kind === 'video' && !/mov|mp4|webm/.test(formatName)) throw new Error('仅支持 MP4 和 WebM 视频');
  if (kind === 'audio' && !/mp3|mov|mp4|m4a|aac|wav|flac|ogg|opus|asf/.test(formatName)) throw new Error('不支持此音频格式');
  const duration = Number(info.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`无法读取${kind === 'video' ? '视频' : '音频'}时长`);
  const limit = kind === 'video' ? MAX_VIDEO_SECONDS : MAX_AUDIO_SECONDS;
  if (duration > limit) throw new Error(`${kind === 'video' ? '视频时长超过 20 分钟' : '音频时长超过 2 小时'}限制`);
  const mime = kind === 'video'
    ? (formatName.includes('webm') ? 'video/webm' : 'video/mp4')
    : formatName.includes('mp3') ? 'audio/mpeg'
      : /mov|mp4|m4a/.test(formatName) ? 'audio/mp4'
        : formatName.includes('wav') ? 'audio/wav'
          : formatName.includes('flac') ? 'audio/flac'
            : /ogg|opus/.test(formatName) ? 'audio/ogg'
              : formatName.includes('asf') ? 'audio/x-ms-wma' : 'audio/aac';
  return { duration, format: formatName, kind, mime };
}
const probe = probeMedia;
export function parseTranscription(result) {
  if (!Array.isArray(result.segments) || !result.segments.length) throw new Error('ASR 未返回分段时间戳，请使用支持 verbose_json 的转写模型');
  const validate = (items, field) => items.flatMap((item, index) => {
    if (typeof item?.[field] === 'string' && !item[field].trim()) return [];
    const invalid = !item || typeof item[field] !== 'string' ? field
      : !Number.isFinite(item.start) || item.start < 0 ? 'start'
      : !Number.isFinite(item.end) || item.end < item.start ? 'end' : null;
    if (invalid) {
      if (field === 'word') return [];
      throw new Error(`ASR 分段时间戳或文字无效：segments[${index}].${invalid}（类型 ${typeof item?.[invalid]}）`);
    }
    return [{ start: item.start, end: item.end, [field]: item[field].trim() }];
  });
  const segments = validate(result.segments, 'text');
  if (!segments.length) throw new Error('ASR 未返回包含文字的有效分段');
  const words = validate(Array.isArray(result.words) ? result.words : [], 'word');
  return { segments, words, text: segments.map(segment => segment.text).join('\n') };
}
export async function transcribe(audio, filename, type = 'audio/mpeg') {
  const base = process.env.ASR_BASE_URL;
  const key = process.env.ASR_API_KEY || process.env.AI_API_KEY;
  if (!base || !key) throw new Error('未配置 ASR_BASE_URL 或转写密钥（ASR_API_KEY / AI_API_KEY）');
  if ((process.env.ASR_MODEL || '').startsWith('qwen3-asr-flash')) {
    throw new Error('当前 Qwen 转写接口未提供真实时间戳，请将 ASR_MODEL 改为 whisper-1，并配置对应的 ASR_BASE_URL');
  }
  const form = new FormData();
  form.set('file', new File([await (await import('node:fs/promises')).readFile(audio)], filename, { type }));
  form.set('model', process.env.ASR_MODEL || 'whisper-1');
  form.set('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'segment');
  form.append('timestamp_granularities[]', 'word');
  const response = await fetch(`${base.replace(/\/$/, '')}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(10 * 60 * 1000) });
  const body = await response.text();
  if (!response.ok) throw new Error(`ASR 失败（HTTP ${response.status}）`);
  return parseTranscription(JSON.parse(body));
}
export const offsetTranscription = (transcription, offset) => ({
  segments: transcription.segments.map(item => ({ ...item, start: item.start + offset, end: item.end + offset })),
  words: transcription.words.map(item => ({ ...item, start: item.start + offset, end: item.end + offset }))
});
export async function transcribeInChunks(audio, duration, work, onProgress = async () => {}) {
  const parts = [];
  const chunkCount = Math.ceil(duration / ASR_CHUNK_SECONDS);
  for (let index = 0; index < chunkCount; index += 1) {
    const start = index * ASR_CHUNK_SECONDS;
    const length = Math.min(ASR_CHUNK_SECONDS, duration - start);
    const chunk = path.join(work, `asr-${index + 1}.mp3`);
    await command(process.env.FFMPEG_BIN || 'ffmpeg', ['-y', '-protocol_whitelist', 'file', '-threads', '2', '-ss', String(start), '-t', String(length), '-i', audio, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '64k', chunk]);
    parts.push(offsetTranscription(await transcribe(chunk, `audio-${index + 1}.mp3`), start));
    await onProgress(index + 1, chunkCount);
  }
  const segments = parts.flatMap(part => part.segments);
  const words = parts.flatMap(part => part.words);
  return { segments, words, text: segments.map(segment => segment.text).join('\n') };
}
const formatTime = seconds => new Date(Math.max(0, Number(seconds) || 0) * 1000).toISOString().slice(11, 19);
export const formatTranscript = transcription => transcription.segments.map(segment => `[${new Date(segment.start * 1000).toISOString().slice(11, 23)}-${new Date(segment.end * 1000).toISOString().slice(11, 23)}] ${segment.text}`).join('\n\n');
async function summaryRequest(base, key, body) {
  const response = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5 * 60 * 1000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`媒体总结失败（HTTP ${response.status}）`);
  return JSON.parse(text).choices?.[0]?.message?.content || '{}';
}
async function summarize(transcript, duration, kind = 'video') {
  const noun = kind === 'audio' ? '音频' : '视频';
  const base = process.env.SUMMARY_BASE_URL || process.env.AI_BASE_URL;
  const key = process.env.SUMMARY_API_KEY || process.env.AI_API_KEY;
  if (!base || !key) throw new Error('未配置总结模型服务');
  let source = transcript;
  if (source.length > 90000) {
    const chunks = source.match(/[\s\S]{1,80000}/g) || [];
    const digests = [];
    for (let index = 0; index < chunks.length; index += 1) digests.push(await summaryRequest(base, key, { model: process.env.SUMMARY_MODEL || process.env.AI_MODEL, temperature: 0.1, messages: [{ role: 'system', content: `忠实压缩带时间戳的${noun}逐字稿，保留所有主题、关键事实和时间范围，不要输出 JSON。` }, { role: 'user', content: `第 ${index + 1}/${chunks.length} 部分：\n${chunks[index]}` }] }));
    source = `以下是覆盖完整逐字稿的分段摘要：\n${digests.join('\n\n')}`;
  }
  source = `输出要求：每个末节点必须返回数字 time、start 和 end，表示该要点对应内容的定位秒数及起止秒数，依据真实时间信息，满足 0 <= start <= time <= end <= ${noun}时长，且 start < end。不要为凑节点数量拆分内容。\n${source}`;
  const system = `你是${noun}内容分析器。只返回 JSON：{"summary":"中文核心总结","mindmap":{"label":"${noun}主题","children":[{"label":"主题分支","children":[{"label":"具体内容要点","time":12.34,"start":10.2,"end":18.7}]}]}}。根据逐字稿组织思维导图，最多5层、50个节点，建议不超过12个末节点。每个末节点必须提供 time、start、end 秒数。非末节点使用 children。你没有获得画面信息，不要编造视觉细节。`;
  const content = await summaryRequest(base, key, { model: process.env.SUMMARY_MODEL || process.env.AI_MODEL, temperature: 0.2, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: `${noun}时长 ${duration.toFixed(1)} 秒。以下内容覆盖完整逐字稿：\n${source}` }] });
  const result = JSON.parse(content);
  const mindmap = validateMindmap(result.mindmap, duration);
  return { summary: String(result.summary || ''), mindmap, keyframes: mindmapLeaves(mindmap) };
}
const mindmapLeaves = node => node.children?.length ? node.children.flatMap(mindmapLeaves) : [node];
export function validateMindmap(node, duration, depth = 0, budget = { count: 0 }) {
  if (!node || typeof node.label !== 'string' || !node.label.trim() || node.label.length > 300 || depth > 4 || ++budget.count > 50) throw new Error('思维导图结构无效');
  if (Array.isArray(node.children) && node.children.length) return { label: node.label.trim(), children: node.children.map(child => validateMindmap(child, duration, depth + 1, budget)) };
  let time = node.time;
  if (typeof time === 'string') {
    const value = time.trim();
    if (/^\d+(?:\.\d+)?$/.test(value)) time = Number(value);
    else if (/^(?:\d+:)?[0-5]\d:[0-5]\d(?:\.\d+)?$/.test(value)) time = value.split(':').reduce((seconds, part) => seconds * 60 + Number(part), 0);
  }
  if (!Number.isFinite(time) || time < 0 || time >= duration) throw new Error(`思维导图末节点时间无效：${node.label.slice(0, 60)}；time=${JSON.stringify(node.time) ?? '缺失'}，要求 0 <= time < ${duration} 秒`);
  if (node.start === undefined && node.end === undefined) return { label: node.label.trim(), time };
  const start = typeof node.start === 'string' && /^\d+(?:\.\d+)?$/.test(node.start.trim()) ? Number(node.start) : node.start;
  const end = typeof node.end === 'string' && /^\d+(?:\.\d+)?$/.test(node.end.trim()) ? Number(node.end) : node.end;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > duration || time < start || time > end) return { label: node.label.trim(), time };
  return { label: node.label.trim(), time, start, end };
}
export function renderMindmap(node, images = null) {
  const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  let index = 0;
  const branch = item => {
    const range = Number.isFinite(item.start) && Number.isFinite(item.end) ? ` data-start="${item.start}" data-end="${item.end}"` : '';
    if (item.children?.length) return `<li${range}><span>${escape(item.label)}</span><ul>${item.children.map(branch).join('')}</ul></li>`;
    const image = images?.[index++];
    return `<li${range} data-time="${item.time}"><span>${escape(item.label)}</span><figure>${image ? `<img src="${escape(image.url)}" alt="${escape(item.label)}">` : ''}<figcaption>${formatTime(item.time)}</figcaption></figure></li>`;
  };
  return `<div class="video-mindmap" data-media-kind="${images ? 'video' : 'audio'}"><ul>${branch(node)}</ul></div>`;
}
export async function findVideoCache(dataDir, attachments) {
  const cache = {};
  for (const item of [...attachments].reverse()) {
    if (typeof item.id !== 'string' || path.basename(item.id) !== item.id || ['.', '..'].includes(item.id)) continue;
    const file = path.join(dataDir, 'attachments', item.id);
    try {
      const info = await stat(file);
      if (!info.isFile() || !info.size) continue;
      const attachment = { ...item, url: `/api/attachments/${item.id}` };
      if (!cache.media && ((item.name === 'video' && ['video/mp4', 'video/webm'].includes(item.type)) || (item.name === 'audio-source' && item.type.startsWith('audio/'))) && info.size <= MAX_VIDEO_BYTES) cache.media = { file, attachment };
      if (!cache.audio && item.name === '音频.wav' && item.type === 'audio/wav') cache.audio = { file, attachment };
      if (!cache.transcription && item.name === 'transcription.json' && item.type === 'application/json' && info.size <= 64 * 1024 * 1024) {
        const result = JSON.parse(await readFile(file, 'utf8'));
        if (result.version !== 1 || !Number.isFinite(result.duration) || result.duration <= 0) continue;
        cache.transcription = { attachment, duration: result.duration, value: parseTranscription(result) };
      }
    } catch {}
  }
  return cache;
}
export async function runVideoJob(job, { dataDir, saveAttachment, update, cachedAttachments = [] }) {
  const work = path.join(dataDir, 'video-jobs', job.id);
  await mkdir(work, { recursive: true, mode: 0o700 });
  const source = path.join(work, 'source');
  const audio = path.join(work, 'audio.wav');
  try {
    const cache = await findVideoCache(dataDir, cachedAttachments);
    let metadata;
    if (cache.media) {
      await update({ status: 'checking', progress: 25 });
      try { await copyFile(cache.media.file, source); metadata = await probe(source); }
      catch { await unlink(source).catch(() => {}); delete cache.media; }
    }
    if (!cache.media) {
      delete cache.audio; delete cache.transcription;
      await update({ status: 'downloading', progress: 10 });
      const downloaded = await download(job.url, source);
      await update({ status: 'checking', progress: 25, bytes: downloaded.size, finalUrl: downloaded.url });
      metadata = await probe(source);
    }
    if (cache.transcription && Math.abs(cache.transcription.duration - metadata.duration) > 0.1) delete cache.transcription;
    await update({ status: 'transcribing', progress: 35, duration: metadata.duration, mediaKind: metadata.kind, mime: metadata.mime });
    if (!cache.audio) await command(process.env.FFMPEG_BIN || 'ffmpeg', ['-y', '-protocol_whitelist', 'file', '-threads', '2', '-i', source, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', audio]);
    let transcription = cache.transcription?.value;
    if (!transcription) transcription = await transcribeInChunks(cache.audio?.file || audio, metadata.duration, work, async (done, total) => update({ status: 'transcribing', progress: 35 + Math.floor(done / total * 20), asrChunks: total, asrChunk: done }));
    const transcript = formatTranscript(transcription);
    await update({ status: 'summarizing', progress: 60 });
    const analysis = await summarize(transcript, metadata.duration, metadata.kind);
    const screenshots = [];
    if (metadata.kind === 'video') {
      await update({ status: 'capturing', progress: 75 });
      for (let index = 0; index < analysis.keyframes.length; index += 1) {
        const item = analysis.keyframes[index], image = path.join(work, `keyframe-${index + 1}.jpg`);
        await command(process.env.FFMPEG_BIN || 'ffmpeg', ['-y', '-protocol_whitelist', 'file', '-threads', '2', '-ss', String(Math.min(Number(item.time), metadata.duration - 0.1)), '-i', source, '-frames:v', '1', '-vf', 'scale=1280:-2', '-q:v', '3', image]);
        screenshots.push({ path: image, name: `关键帧-${index + 1}.jpg`, time: item.time, description: item.label });
      }
    }
    await update({ status: 'saving', progress: 90 });
    const sourceAttachment = cache.media?.attachment || await saveAttachment({ path: source, name: metadata.kind === 'video' ? 'video' : 'audio-source', type: metadata.mime });
    let audioAttachment = cache.audio?.attachment;
    if (!audioAttachment) {
      if (cache.media) await copyFile(audio, path.join(work, 'audio-save.wav'));
      audioAttachment = await saveAttachment({ path: cache.media ? path.join(work, 'audio-save.wav') : audio, name: '音频.wav', type: 'audio/wav' });
    }
    const transcriptionFile = path.join(work, 'transcription.json');
    await (await import('node:fs/promises')).writeFile(transcriptionFile, JSON.stringify({ version: 1, model: process.env.ASR_MODEL || 'whisper-1', duration: metadata.duration, ...transcription }), { mode: 0o600 });
    const transcriptionAttachment = cache.transcription?.attachment || await saveAttachment({ path: transcriptionFile, name: 'transcription.json', type: 'application/json' });
    const imageAttachments = [];
    for (const screenshot of screenshots) imageAttachments.push({ ...await saveAttachment({ path: screenshot.path, name: screenshot.name, type: 'image/jpeg' }), time: screenshot.time, description: screenshot.description });
    const illustrated = renderMindmap(analysis.mindmap, metadata.kind === 'video' ? imageAttachments : null);
    const media = metadata.kind === 'video' ? ['## 原视频：', `<video controls src="${sourceAttachment.url}"></video>`] : ['## 原音频：', `<audio controls src="${sourceAttachment.url}"></audio>`];
    const markdown = [...media, '## 核心总结：', analysis.summary, '## 思维导图：', illustrated, '## 真的时间戳-逐字稿：', transcript, `[下载时间戳数据](${transcriptionAttachment.url})`, '## 音频：', `[audio](${audioAttachment.url})`].join('\n\n');
    await update({ status: 'completed', progress: 100, markdown, mediaKind: metadata.kind, mime: metadata.mime, attachments: [sourceAttachment, audioAttachment, transcriptionAttachment, ...imageAttachments] });
  } catch (error) {
    await update({ status: 'failed', progress: 100, error: error instanceof Error ? error.message : '媒体任务失败' });
  } finally {
    const { rm } = await import('node:fs/promises');
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
