import test from 'node:test';
import assert from 'node:assert/strict';
import specData from '../../pet-spec.json';
import type { PetSpec, WalkConfig } from '../../src/shared/contracts';
import { parseTuningWalk, parseWalkConfig } from '../../src/main/walk-tuning';

const spec = specData as PetSpec;
const valid = spec.motion.walk;
const withLevel = (patch: Partial<WalkConfig['levels'][number] & object>) => ({
  ...valid,
  levels: [null, { ...(valid.levels[1] as object), ...patch }, valid.levels[2], valid.levels[3], valid.levels[4]],
});

test('spec defaults are a valid walk config', () => {
  assert.deepEqual(parseWalkConfig(valid), valid);
  assert.deepEqual(parseTuningWalk({ walk: valid }), valid);
});

test('walk config rejects malformed shapes', () => {
  assert.throws(() => parseWalkConfig(null), /Invalid walk config/);
  assert.throws(() => parseWalkConfig([]), /Invalid walk config/);
  assert.throws(() => parseWalkConfig({ ...valid, levels: [null, valid.levels[1]] }), /levels must have 5 entries/);
  assert.throws(() => parseWalkConfig({ ...valid, levels: [{}, valid.levels[1], valid.levels[2], valid.levels[3], valid.levels[4]] }), /levels\[0\]/);
  assert.throws(() => parseWalkConfig({ ...valid, speed: 0 }), /speed/);
  assert.throws(() => parseWalkConfig({ ...valid, speed: 999 }), /speed/);
  assert.throws(() => parseWalkConfig({ ...valid, frameMs: 4 }), /frameMs/);
});

test('walk level keeps interval, distance and radius consistent', () => {
  assert.throws(() => parseWalkConfig(withLevel({ intervalMin: 30_000, intervalMax: 10_000 })), /intervalMin > intervalMax/);
  assert.throws(() => parseWalkConfig(withLevel({ distMin: 300, distMax: 100 })), /distMin > distMax/);
  assert.throws(() => parseWalkConfig(withLevel({ range: 100, distMax: 200 })), /distMax > range/);
  assert.throws(() => parseWalkConfig(withLevel({ range: 0 })), /range/);
  assert.throws(() => parseWalkConfig(withLevel({ intervalMax: 0 })), /intervalMax/);
});

test('tuning file tolerates missing or unrelated groups', () => {
  assert.equal(parseTuningWalk(undefined), undefined);
  assert.equal(parseTuningWalk(null), undefined);
  assert.equal(parseTuningWalk({}), undefined);
  assert.equal(parseTuningWalk({ other: 1 }), undefined);
  assert.throws(() => parseTuningWalk([]), /Invalid tuning file/);
  assert.throws(() => parseTuningWalk({ walk: { speed: 2 } }), /Invalid tuning.walk config/);
});
