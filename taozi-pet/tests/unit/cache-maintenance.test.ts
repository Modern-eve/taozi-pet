import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  formatBytes,
  measureDirectory,
  purgeChromiumCaches,
  runCacheMaintenance,
  sweepWriteResidue,
  trimLogFile,
} from '../../src/main/cache-maintenance';

async function makeUserData(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'desktop-pet-cache-'));
}

test('chromium cache directories are purged while business files stay', async () => {
  const directory = await makeUserData();
  try {
    await mkdir(path.join(directory, 'Cache', 'Cache_Data'), { recursive: true });
    await writeFile(path.join(directory, 'Cache', 'Cache_Data', 'f_000001'), 'x'.repeat(2048));
    await mkdir(path.join(directory, 'GPUCache'), { recursive: true });
    await writeFile(path.join(directory, 'GPUCache', 'data_0'), 'gpu');
    await writeFile(path.join(directory, 'settings.json'), '{"edgeSnap":true}\n');
    await writeFile(path.join(directory, 'pet-stats.json'), '{}\n');

    const swept = await purgeChromiumCaches(directory);
    assert.equal(swept.files, 2);
    assert.ok(swept.bytes >= 2051);
    assert.deepEqual((await readdir(directory)).sort(), ['pet-stats.json', 'settings.json']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('temp residue is removed and corrupt files keep the newest N', async () => {
  const directory = await makeUserData();
  try {
    await writeFile(path.join(directory, 'settings.json.aaa.tmp'), 'tmp-a');
    await writeFile(path.join(directory, 'reminders.json.bbb.tmp'), 'tmp-b');
    const older = path.join(directory, 'settings.json.2026-08-01T00-00-00.000Z.corrupt');
    const newer = path.join(directory, 'pet-stats.json.2026-09-01T00-00-00.000Z.corrupt');
    await writeFile(older, 'old');
    await writeFile(newer, 'new');
    await utimes(older, new Date('2026-08-01T00:00:00Z'), new Date('2026-08-01T00:00:00Z'));
    await utimes(newer, new Date('2026-09-01T00:00:00Z'), new Date('2026-09-01T00:00:00Z'));

    const { tempFiles, corruptFiles } = await sweepWriteResidue(directory, 1);
    assert.equal(tempFiles.files, 2);
    assert.equal(corruptFiles.files, 1);
    assert.deepEqual(await readdir(directory), ['pet-stats.json.2026-09-01T00-00-00.000Z.corrupt']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('oversized log is trimmed to the limit keeping the newest records', async () => {
  const directory = await makeUserData();
  try {
    const file = path.join(directory, 'app.jsonl');
    const lines = Array.from({ length: 200 }, (_unused, index) => JSON.stringify({ seq: index, pad: 'x'.repeat(50) }));
    await writeFile(file, `${lines.join('\n')}\n`, 'utf8');

    const maxBytes = 1024;
    const freed = await trimLogFile(file, maxBytes);
    assert.ok(freed > 0);
    assert.ok((await stat(file)).size <= maxBytes);

    const remaining = (await readFile(file, 'utf8')).trim().split('\n');
    assert.ok(remaining.length > 0);
    const last = JSON.parse(remaining[remaining.length - 1]!) as { seq: number };
    const first = JSON.parse(remaining[0]!) as { seq: number };
    assert.equal(last.seq, 199);
    assert.equal(first.seq, 199 - remaining.length + 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('log under the limit is left untouched', async () => {
  const directory = await makeUserData();
  try {
    const file = path.join(directory, 'app.jsonl');
    const content = '{"seq":1}\n{"seq":2}\n';
    await writeFile(file, content, 'utf8');
    assert.equal(await trimLogFile(file, 1024), 0);
    assert.equal(await readFile(file, 'utf8'), content);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('combined maintenance reports freed bytes and keeps business data readable', async () => {
  const directory = await makeUserData();
  try {
    await mkdir(path.join(directory, 'Code Cache'), { recursive: true });
    await writeFile(path.join(directory, 'Code Cache', 'js'), 'code');
    await writeFile(path.join(directory, 'settings.json.zzz.tmp'), 'tmp');
    await writeFile(path.join(directory, 'settings.json'), '{"edgeSnap":true}\n');
    const logFile = path.join(directory, 'logs', 'app.jsonl');
    await mkdir(path.dirname(logFile), { recursive: true });
    await writeFile(logFile, `${Array.from({ length: 100 }, (_unused, index) => JSON.stringify({ index })).join('\n')}\n`);

    const report = await runCacheMaintenance({ userDataDir: directory, logFile, keepCorruptFiles: 3, logMaxBytes: 200 });
    assert.equal(report.caches.files, 1);
    assert.equal(report.tempFiles.files, 1);
    assert.equal(report.corruptFiles.files, 0);
    assert.ok(report.logTrimmedBytes > 0);
    assert.equal(await readFile(path.join(directory, 'settings.json'), 'utf8'), '{"edgeSnap":true}\n');
    assert.ok((await measureDirectory(directory)).files >= 2);
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(2048), '2.0 KB');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
