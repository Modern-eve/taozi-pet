import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonLogger } from '../../src/main/logger';

test('logger writes one JSON object per line and creates its directory', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'desktop-pet-logger-'));
  try {
    const file = path.join(directory, 'logs', 'app.jsonl');
    const logger = new JsonLogger(file);
    await logger.write('info', 'main-initializing', { version: '4.2.2' });
    await logger.write('warn', 'typing-listener-status', { enabled: false });

    const lines = (await readFile(file, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 2);
    const [first, second] = lines.map((line) => JSON.parse(line));
    assert.equal(first.event, 'main-initializing');
    assert.equal(first.level, 'info');
    assert.equal(first.version, '4.2.2');
    assert.match(first.timestamp, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(second.enabled, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('logger writes with no extra payload', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'desktop-pet-logger-'));
  try {
    const file = path.join(directory, 'app.jsonl');
    await new JsonLogger(file).write('error', 'renderer-runtime-failed');
    const entry = JSON.parse((await readFile(file, 'utf8')).trim());
    assert.equal(entry.event, 'renderer-runtime-failed');
    assert.equal(entry.level, 'error');
    assert.equal(Object.keys(entry).length, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('logger never throws when the log path is unusable', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'desktop-pet-logger-'));
  try {
    const blocker = path.join(directory, 'blocker');
    await writeFile(blocker, 'not a directory', 'utf8');
    await new JsonLogger(path.join(blocker, 'nested', 'app.jsonl')).write('info', 'ignored');
    assert.equal(await readFile(blocker, 'utf8'), 'not a directory');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
