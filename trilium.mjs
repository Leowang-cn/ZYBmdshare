import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, access, rename, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import { root } from './server.mjs';

const version = 'v0.106.0';
const filename = `TriliumNotes-Server-${version}-linux-x64.tar.xz`;
const expected = 'c693a28eb86d2892e30553d8fd9a171f4d72e5c76f02dd3fb335f6bd476b6aec';
const directory = path.join(root, '.runtime');
const archive = path.join(directory, filename);
const extracted = path.join(directory, version);

async function checksum(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

async function findFiles(directoryPath, predicate, depth = 0) {
  if (depth > 12) return [];
  const results = [];
  for (const entry of await readdir(directoryPath, { withFileTypes: true })) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) results.push(...await findFiles(entryPath, predicate, depth + 1));
    else if (entry.isFile() && predicate(entry.name)) results.push(entryPath);
  }
  return results;
}

try {
  if (!['prepare', 'check'].includes(process.argv[2])) throw new Error('Usage: node trilium.mjs prepare|check');
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Run this check on the Linux x64 deployment server, not on macOS');
  if (process.argv[2] === 'prepare') {
    await mkdir(directory, { recursive: true });
    let exists = false;
    try { await access(archive); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!exists) {
      console.log(`Downloading official Trilium ${version} (about 94 MB)`);
      const response = await fetch(`https://github.com/TriliumNext/Trilium/releases/download/${version}/${filename}`, { signal: AbortSignal.timeout(180000) });
      if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
      try {
        await pipeline(Readable.fromWeb(response.body), createWriteStream(`${archive}.part`, { flags: 'w' }));
        if (await checksum(`${archive}.part`) !== expected) throw new Error('SHA-256 mismatch');
        await rename(`${archive}.part`, archive);
      } finally {
        await rm(`${archive}.part`, { force: true });
      }
    }
    if (await checksum(archive) !== expected) throw new Error('Cached archive SHA-256 mismatch; remove it manually before retrying');
    const members = run('tar', ['-tJf', archive]).split('\n');
    if (members.some(member => member.startsWith('/') || member.split('/').includes('..'))) throw new Error('Unsafe archive paths');
    await mkdir(extracted, { recursive: true });
    run('tar', ['-xJf', archive, '-C', extracted]);
    console.log('Official archive checksum and extraction passed');
  }
  const binaries = await findFiles(extracted, name => name === 'node');
  if (binaries.length !== 1) throw new Error(`Expected one packaged Node binary, found ${binaries.length}`);
  const packagedVersion = run(binaries[0], ['--version']);
  const modules = await findFiles(extracted, name => name.endsWith('.node'));
  const checks = modules.map(modulePath => {
    const result = spawnSync('ldd', [modulePath], { encoding: 'utf8', timeout: 10000 });
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    return { module: path.relative(extracted, modulePath), ok: !result.error && result.status === 0 && !/not found/.test(output), details: output.trim() };
  });
  const ok = checks.length > 0 && checks.every(check => check.ok);
  console.log(JSON.stringify({ ok, version, packagedVersion, nativeLibraries: checks, scope: 'Runtime and shared-library checks only. Application startup, Node ABI, sharing and API remain unverified.' }, null, 2));
  if (!ok) process.exitCode = 1;
} catch (error) {
  console.error(`Trilium compatibility check failed: ${error.message}`);
  process.exitCode = 1;
}