import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, statfs } from 'node:fs/promises';
import { createNotes } from './notes.mjs';

export const root = path.dirname(fileURLToPath(import.meta.url));

export function parsePort(args = process.argv.slice(2), env = process.env) {
  const index = args.indexOf('--port');
  const value = index >= 0 ? args[index + 1] : (env.PORT || '8080');
  if (!/^\d+$/.test(value || '') || Number(value) < 1 || Number(value) > 65535) {
    throw new Error('PORT or --port must be an integer between 1 and 65535');
  }
  return Number(value);
}

function authorized(header, token) {
  const actual = Buffer.from(header || '');
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function createProbe({ dataDir = path.join(root, 'data'), token = process.env.ACCESS_TOKEN } = {}) {
  if (!token || token.length < 24) throw new Error('Set ACCESS_TOKEN to at least 24 characters');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const markerPath = path.join(dataDir, 'probe.json');
  let marker;
  try {
    marker = JSON.parse(await readFile(markerPath, 'utf8'));
    if (typeof marker.id !== 'string' || !Number.isInteger(marker.boots) || marker.boots < 1) {
      throw new Error('Invalid persistence marker; refusing to overwrite it');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    marker = { id: randomUUID(), createdAt: new Date().toISOString(), boots: 0 };
  }
  marker.boots += 1;
  marker.lastStartedAt = new Date().toISOString();
  await writeFile(`${markerPath}.tmp`, JSON.stringify(marker, null, 2), { mode: 0o600 });
  await rename(`${markerPath}.tmp`, markerPath);
  const notes = await createNotes({ dataDir, token });
  const started = Date.now();
  const server = http.createServer(async (request, response) => {
    const send = (status, body) => {
      response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      response.end(JSON.stringify(body, null, 2));
    };
    try {
      const url = new URL(request.url, 'http://localhost');
      if (await notes(request, response, url)) return;
      const route = url.pathname;
      if (request.method !== 'GET') return send(405, { error: 'Method not allowed' });
      const asset = route === '/' || /^\/s\/[a-f0-9]{64}$/.test(route) ? 'index.html' : route.slice(1);
      if (/^(?:index\.html|[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:js|css)|assets\/[A-Za-z0-9_.-]+\.(?:woff2?|ttf))$/.test(asset)) {
        try {
          const content = await readFile(path.join(root, 'public', asset));
          const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
          response.writeHead(200, { 'Content-Type': types[path.extname(asset)], 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: http: data:; media-src 'self' https: http:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
          response.end(content);
          return;
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      if (route === '/api/health') {
        await readFile(markerPath);
        return send(200, { ok: true, service: 'mdshare-deployment-probe', triliumVerified: false });
      }
      if (route === '/') return send(200, { service: 'mdshare-deployment-probe', health: '/api/health', report: '/api/report', authentication: 'Authorization: Bearer <ACCESS_TOKEN>' });
      if (route !== '/api/report') return send(404, { error: 'Not found' });
      if (!authorized(request.headers.authorization, token)) return send(401, { error: 'Unauthorized' });
      const filesystem = await statfs(dataDir);
      const runtime = process.report.getReport().header;
      return send(200, {
        scope: 'Host probe only; Trilium and public sharing are not verified',
        runtime: { node: process.version, executable: process.execPath, platform: process.platform, arch: process.arch, kernel: os.release(), glibc: runtime.glibcVersionRuntime || null },
        resources: { hostCpus: os.cpus().length, hostMemoryBytes: os.totalmem(), hostFreeMemoryBytes: os.freemem(), diskAvailableBytes: filesystem.bavail * filesystem.bsize, note: 'Host values are not per-project quotas' },
        persistence: marker,
        uptimeSeconds: Math.floor((Date.now() - started) / 1000)
      });
    } catch {
      send(503, { ok: false, error: 'Probe storage or report unavailable' });
    }
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const port = parsePort();
    const server = await createProbe({ dataDir: path.resolve(root, process.env.DATA_DIR || 'data') });
    server.on('error', error => { console.error(error.message); process.exitCode = 1; });
    server.listen(port, '0.0.0.0', () => console.log(`Deployment probe listening on 0.0.0.0:${port}`));
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.on(signal, () => {
        server.close();
        setTimeout(() => process.exit(1), 5000).unref();
      });
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}