import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { promises as dns } from 'node:dns';
import { spawn } from 'node:child_process';
import { mkdir, open, unlink } from 'node:fs/promises';
import path from 'node:path';

export const MAX_VIDEO_BYTES = 512 * 1024 * 1024;
export const MAX_VIDEO_SECONDS = 600;
const MAX_REDIRECTS = 3;
const MAX_URLS_PER_JOB = 20;
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
const publicHost = async hostname => {
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) throw new Error('视频 URL 不允许访问本机地址');
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!records.length || records.some(({ address }) => isPrivateAddress(address))) throw new Error('视频 URL 不允许访问内网或保留地址');
  return records[0];
};
export const checkUrl = async value => {
  let url;
  try { url = new URL(value); } catch { throw new Error('视频 URL 无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('视频 URL 必须是无认证的 HTTP(S) 地址');
  if (value.length > 4096) throw new Error('视频 URL 过长');
  const address = await publicHost(url.hostname.replace(/^\[|\]$/g, ''));
  return { url, address };
};
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
async function probe(file) {
  const { stdout } = await command(process.env.FFPROBE_BIN || 'ffprobe', ['-v', 'error', '-protocol_whitelist', 'file', '-show_entries', 'format=duration,format_name:stream=codec_type', '-of', 'json', file]);
  const parsed = JSON.parse(stdout);
  if (!parsed.streams?.some(stream => stream.codec_type === 'video')) throw new Error('文件没有视频轨道');
  const info = parsed.format || {};
  if (!/mov|mp4|webm/.test(info.format_name || '')) throw new Error('仅支持 MP4 和 WebM 视频');
  const duration = Number(info.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('无法读取视频时长');
  if (duration > MAX_VIDEO_SECONDS) throw new Error('视频时长超过 10 分钟限制');
  return { duration, format: info.format_name || 'video/mp4' };
}
async function transcribe(audio, filename) {
  const base = process.env.ASR_BASE_URL;
  const key = process.env.ASR_API_KEY || process.env.AI_API_KEY;
  if (!base || !key) throw new Error('未配置 ASR_BASE_URL 或转写密钥（ASR_API_KEY / AI_API_KEY）');
  if ((process.env.ASR_MODEL || '').startsWith('qwen3-asr-flash')) {
    const audioBytes = await (await import('node:fs/promises')).readFile(audio);
    const response = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: process.env.ASR_MODEL, messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: `data:audio/mp3;base64,${audioBytes.toString('base64')}` } }] }], stream: false, asr_options: { enable_itn: false } }),
      signal: AbortSignal.timeout(10 * 60 * 1000)
    });
    if (!response.ok) throw new Error(`ASR 失败（HTTP ${response.status}）`);
    const result = await response.json();
    const text = result.choices?.[0]?.message?.content;
    if (typeof text !== 'string') throw new Error('ASR 返回格式无效');
    return text.trim() ? `（当前转写模型未提供时间戳）\n\n${text.trim()}` : '';
  }
  const form = new FormData();
  form.set('file', new File([await (await import('node:fs/promises')).readFile(audio)], filename, { type: 'audio/mpeg' }));
  form.set('model', process.env.ASR_MODEL || 'whisper-1');
  form.set('response_format', 'verbose_json');
  const response = await fetch(`${base.replace(/\/$/, '')}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(10 * 60 * 1000) });
  const body = await response.text();
  if (!response.ok) throw new Error(`ASR 失败（HTTP ${response.status}）`);
  const result = JSON.parse(body);
  return result.segments?.length ? result.segments.map(segment => `[${formatTime(segment.start)}-${formatTime(segment.end)}] ${segment.text.trim()}`).join('\n') : (result.text || '');
}
const formatTime = seconds => new Date(Math.max(0, Number(seconds) || 0) * 1000).toISOString().slice(11, 19);
async function summarize(transcript, duration) {
  if (transcript.startsWith('（当前转写模型未提供时间戳）')) transcript = `此逐字稿没有时间信息，无法可靠定位关键帧。请返回空 keyframes 数组，不要猜测内容出现的时间。\n${transcript}`;
  const base = process.env.SUMMARY_BASE_URL || process.env.AI_BASE_URL;
  const key = process.env.SUMMARY_API_KEY || process.env.AI_API_KEY;
  if (!base || !key) throw new Error('未配置总结模型服务');
  const response = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: process.env.SUMMARY_MODEL || process.env.AI_MODEL, temperature: 0.2, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: '你是视频内容分析器。只返回 JSON：{"summary":"中文核心总结","keyframes":[{"time":秒数,"reason":"截图理由","description":"对应时间段的中文内容描述"}]}。最多返回 6 个关键帧，按时间顺序排列，时间必须在视频时长内。description 将与该时间的截图配对组成图文描述，应依据逐字稿讲述该段内容，而不是仅解释截图理由。你没有看到视频画面，不要编造视觉细节。' }, { role: 'user', content: `视频时长 ${duration.toFixed(1)} 秒。以下是带时间戳的逐字稿：\n${transcript.slice(0, 100000)}` }] }), signal: AbortSignal.timeout(5 * 60 * 1000) });
  const body = await response.text();
  if (!response.ok) throw new Error(`视频总结失败（HTTP ${response.status}）`);
  const content = JSON.parse(body).choices?.[0]?.message?.content || '{}';
  const result = JSON.parse(content);
  return { summary: String(result.summary || ''), keyframes: Array.isArray(result.keyframes) ? result.keyframes.filter(item => Number.isFinite(Number(item.time)) && Number(item.time) >= 0 && Number(item.time) <= duration).sort((left, right) => Number(left.time) - Number(right.time)).slice(0, 6) : [] };
}
export async function runVideoJob(job, { dataDir, saveAttachment, update }) {
  const work = path.join(dataDir, 'video-jobs', job.id);
  await mkdir(work, { recursive: true, mode: 0o700 });
  const source = path.join(work, 'source');
  const audio = path.join(work, 'audio.wav');
  const transcriptionAudio = path.join(work, 'transcription.mp3');
  try {
    await update({ status: 'downloading', progress: 10 });
    const downloaded = await download(job.url, source);
    await update({ status: 'checking', progress: 25, bytes: downloaded.size, finalUrl: downloaded.url });
    const metadata = await probe(source);
    await update({ status: 'transcribing', progress: 40, duration: metadata.duration });
    await command(process.env.FFMPEG_BIN || 'ffmpeg', ['-y', '-protocol_whitelist', 'file', '-threads', '2', '-i', source, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', audio]);
    await command(process.env.FFMPEG_BIN || 'ffmpeg', ['-y', '-protocol_whitelist', 'file', '-threads', '2', '-i', audio, '-c:a', 'libmp3lame', '-b:a', '64k', transcriptionAudio]);
    let transcript;
    if ((process.env.ASR_MODEL || '').startsWith('qwen3-asr-flash')) {
      const parts = [];
      for (let start = 0; start < metadata.duration; start += 60) {
        const chunk = path.join(work, `transcription-${start}.mp3`);
        await command(process.env.FFMPEG_BIN || 'ffmpeg', ['-y', '-protocol_whitelist', 'file', '-threads', '2', '-ss', String(start), '-i', audio, '-t', String(Math.min(60, metadata.duration - start)), '-c:a', 'libmp3lame', '-b:a', '64k', chunk]);
        const text = (await transcribe(chunk, 'audio.mp3')).replace(/^（当前转写模型未提供时间戳）\n\n/, '');
        parts.push(`[${formatTime(start)}-${formatTime(Math.min(start + 60, metadata.duration))}] ${text || '（ASR 未返回文字）'}`);
        await update({ status: 'transcribing', progress: 40 + Math.floor(19 * Math.min(start + 60, metadata.duration) / metadata.duration) });
      }
      transcript = `（以下时间为音频切片范围，不是逐句时间戳）\n\n${parts.join('\n\n')}`;
    } else {
      transcript = await transcribe(transcriptionAudio, 'audio.mp3');
    }
    await update({ status: 'summarizing', progress: 60 });
    const analysis = await summarize(transcript, metadata.duration);
    await update({ status: 'capturing', progress: 75 });
    const screenshots = [];
    for (let index = 0; index < analysis.keyframes.length; index += 1) {
      const item = analysis.keyframes[index];
      const image = path.join(work, `keyframe-${index + 1}.jpg`);
      await command(process.env.FFMPEG_BIN || 'ffmpeg', ['-y', '-protocol_whitelist', 'file', '-threads', '2', '-ss', String(Math.min(Number(item.time), metadata.duration - 0.1)), '-i', source, '-frames:v', '1', '-vf', 'scale=1280:-2', '-q:v', '3', image]);
      screenshots.push({ path: image, name: `关键帧-${index + 1}.jpg`, time: item.time, description: String(item.description || item.reason || '') });
    }
    await update({ status: 'saving', progress: 90 });
    const video = await saveAttachment({ path: source, name: 'video', type: metadata.format.includes('webm') ? 'video/webm' : 'video/mp4' });
    const audioAttachment = await saveAttachment({ path: audio, name: '音频.wav', type: 'audio/wav' });
    const imageAttachments = [];
    for (const screenshot of screenshots) imageAttachments.push({ ...await saveAttachment({ path: screenshot.path, name: screenshot.name, type: 'image/jpeg' }), time: screenshot.time, description: screenshot.description });
    const illustrated = imageAttachments.length ? imageAttachments.map(item => `### ${formatTime(item.time)}\n\n${item.description}\n\n![关键帧](${item.url})`).join('\n\n') : '（暂无图文描述）';
    const markdown = ['## 原视频：', `<video controls src="${video.url}"></video>`, '## 核心总结：', analysis.summary, '## 图文描述：', illustrated, '## 带时间戳逐字稿：', transcript || '（ASR 未返回文字）', '## 音频：', `[audio](${audioAttachment.url})`].join('\n\n');
    await update({ status: 'completed', progress: 100, markdown, attachments: [video, audioAttachment, ...imageAttachments] });
  } catch (error) {
    await update({ status: 'failed', progress: 100, error: error instanceof Error ? error.message : '视频任务失败' });
  } finally {
    await unlink(source).catch(() => {});
    await unlink(audio).catch(() => {});
    const { rm } = await import('node:fs/promises');
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
