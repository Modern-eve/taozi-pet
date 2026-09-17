import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_TIMER_DELAY_MS,
  localDateKey,
  nextReminderDelay,
  parsePersistedStats,
  parseQuotes,
  parseReminders,
  parseSettings,
} from '../../src/main/data-validation';
import type { Settings } from '../../src/shared/contracts';

const validSettings: Settings = {
  edgeSnap: true,
  alwaysOnTop: true,
  typingReaction: false,
  clickThrough: false,
  petScale: 0.8,
  autoStart: true,
  autoStartInit: true,
  randomWalk: 2,
  devMode: false,
};

const validStats = {
  affection: 12,
  mood: 40,
  todayInteractions: 3,
  totalCompanionMs: 90_000,
  lastInteractionDate: '2026-09-17',
  dailyInteractionDates: { hug: '2026-09-17' },
  lastMoodDecayMs: 1_700_000_000_000,
};

test('settings round-trip and reject unknown or mistyped fields', () => {
  assert.deepEqual(parseSettings(validSettings), validSettings);
  assert.throws(() => parseSettings({ ...validSettings, nope: 1 }), /Unknown settings field/);
  assert.throws(() => parseSettings({ ...validSettings, edgeSnap: 'yes' }), /Invalid settings field: edgeSnap/);
  assert.throws(() => parseSettings({ ...validSettings, autoStartInit: 1 }), /Invalid settings field: autoStartInit/);
  assert.throws(() => parseSettings({ ...validSettings, devMode: 'on' }), /Invalid settings field: devMode/);
  assert.throws(() => parseSettings('settings'), /Invalid settings/);
});

test('petScale is clamped to 50%-150%', () => {
  assert.equal(parseSettings({ ...validSettings, petScale: 0.5 }).petScale, 0.5);
  assert.equal(parseSettings({ ...validSettings, petScale: 1.5 }).petScale, 1.5);
  assert.throws(() => parseSettings({ ...validSettings, petScale: 0.49 }), /petScale/);
  assert.throws(() => parseSettings({ ...validSettings, petScale: 1.51 }), /petScale/);
  assert.throws(() => parseSettings({ ...validSettings, petScale: Number.NaN }), /petScale/);
});

test('randomWalk accepts legacy booleans and 0-4 levels only', () => {
  assert.equal(parseSettings({ ...validSettings, randomWalk: true }).randomWalk, 2);
  assert.equal(parseSettings({ ...validSettings, randomWalk: false }).randomWalk, 0);
  assert.equal(parseSettings({ ...validSettings, randomWalk: 4 }).randomWalk, 4);
  assert.throws(() => parseSettings({ ...validSettings, randomWalk: 5 }), /randomWalk/);
  assert.throws(() => parseSettings({ ...validSettings, randomWalk: 1.5 }), /randomWalk/);
});

test('missing optional settings fall back to documented defaults', () => {
  const parsed = parseSettings({ ...validSettings, autoStartInit: undefined, devMode: undefined });
  assert.equal(parsed.autoStartInit, true);
  assert.equal(parsed.devMode, false);
});

test('stats validation enforces ranges and integer interaction count', () => {
  assert.deepEqual(parsePersistedStats(validStats), validStats);
  assert.throws(() => parsePersistedStats({ ...validStats, mood: 101 }), /Invalid stats field: mood/);
  assert.throws(() => parsePersistedStats({ ...validStats, affection: -1 }), /Invalid stats field: affection/);
  assert.throws(() => parsePersistedStats({ ...validStats, todayInteractions: 1.5 }), /todayInteractions/);
  assert.throws(() => parsePersistedStats({ ...validStats, lastInteractionDate: '2026/09/17' }), /lastInteractionDate/);
});

test('stats tolerate absent optional fields', () => {
  const { dailyInteractionDates, lastMoodDecayMs, ...rest } = validStats;
  void dailyInteractionDates;
  void lastMoodDecayMs;
  const parsed = parsePersistedStats(rest);
  assert.deepEqual(parsed.dailyInteractionDates, {});
  assert.equal(typeof parsed.lastMoodDecayMs, 'number');
});

test('reminders validation rejects malformed entries', () => {
  const reminder = { id: 'r1', text: '喝水', dueAt: '2026-09-17T10:00:00.000Z', createdAt: '2026-09-17T09:00:00.000Z' };
  assert.deepEqual(parseReminders([reminder]), [reminder]);
  assert.deepEqual(parseReminders([]), []);
  assert.throws(() => parseReminders({}), /Invalid reminders/);
  assert.throws(() => parseReminders([{ ...reminder, text: '   ' }]), /Invalid reminder text/);
  assert.throws(() => parseReminders([{ ...reminder, dueAt: 'tomorrow' }]), /Invalid reminder dueAt/);
  assert.throws(() => parseReminders([{ ...reminder, id: '' }]), /Invalid reminder id/);
});

test('quotes validation enforces key, list and text bounds', () => {
  assert.deepEqual(parseQuotes({ look: ['你好', '嘿'] }), { look: ['你好', '嘿'] });
  assert.deepEqual(parseQuotes({}), {});
  assert.throws(() => parseQuotes([]), /Invalid quotes/);
  assert.throws(() => parseQuotes({ look: 'not-a-list' }), /Invalid quotes list/);
  assert.throws(() => parseQuotes({ look: [1] }), /Invalid quote text/);
  assert.throws(() => parseQuotes({ ['x'.repeat(51)]: [] }), /Invalid quotes key/);
});

test('reminder delay clamps to the timer limit and never goes negative', () => {
  const now = Date.parse('2026-09-17T10:00:00.000Z');
  assert.equal(nextReminderDelay('2026-09-17T09:59:00.000Z', now), 0);
  assert.equal(nextReminderDelay('2026-09-17T10:01:00.000Z', now), 60_000);
  assert.equal(nextReminderDelay('2200-01-01T00:00:00.000Z', now), MAX_TIMER_DELAY_MS);
});

test('local date key is zero padded', () => {
  assert.equal(localDateKey(new Date(2026, 0, 5)), '2026-01-05');
  assert.match(localDateKey(), /^\d{4}-\d{2}-\d{2}$/);
});
