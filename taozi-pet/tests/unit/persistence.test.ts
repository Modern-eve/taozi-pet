import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { atomicWriteJson, readValidatedJson, type CorruptFallbackNotice } from '../../src/main/persistence';
import { parseSettings } from '../../src/main/data-validation';
import type { Settings } from '../../src/shared/contracts';

const defaults: Settings = {
  edgeSnap: true,
  alwaysOnTop: true,
  typingReaction: false,
  clickThrough: false,
  petScale: 1,
  autoStart: true,
  autoStartInit: true,
  randomWalk: 2,
  devMode: false,
  filePocket: true,
  filePocketDir: '',
};

test('atomic JSON persistence round-trips without temporary files', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'desktop-pet-persistence-'));
  try {
    const file = path.join(directory, 'settings.json');
    await atomicWriteJson(file, defaults);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), defaults);
    assert.equal((await readdir(directory)).some((name) => name.endsWith('.tmp')), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('invalid persisted data is backed up and defaults are restored', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'desktop-pet-corrupt-'));
  try {
    const file = path.join(directory, 'settings.json');
    await writeFile(file, '{"edgeSnap":"yes"}', 'utf8');
    assert.deepEqual(await readValidatedJson(file, defaults, parseSettings), defaults);
    const names = await readdir(directory);
    assert.equal(names.includes('settings.json'), false);
    assert.equal(names.some((name) => name.startsWith('settings.json.') && name.endsWith('.corrupt')), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('missing persistence files use defaults without a corrupt backup', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'desktop-pet-missing-'));
  try {
    const file = path.join(directory, 'settings.json');
    const notices: CorruptFallbackNotice[] = [];
    assert.deepEqual(await readValidatedJson(file, defaults, parseSettings, (notice) => notices.push(notice)), defaults);
    assert.deepEqual(await readdir(directory), []);
    assert.equal(notices.length, 0); // 尚未写入不算损坏，不应留痕
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('corrupt fallback reports the isolated backup and reason', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'desktop-pet-notice-'));
  try {
    const file = path.join(directory, 'settings.json');
    await writeFile(file, '{"edgeSnap":"yes"}', 'utf8');
    const notices: CorruptFallbackNotice[] = [];
    assert.deepEqual(await readValidatedJson(file, defaults, parseSettings, (notice) => notices.push(notice)), defaults);
    assert.equal(notices.length, 1);
    const [notice] = notices;
    assert.ok(notice);
    assert.equal(notice.file, file);
    assert.equal(notice.corruptFile?.endsWith('.corrupt'), true);
    assert.equal(notice.reason.length > 0, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
