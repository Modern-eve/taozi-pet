import type { Reminder, Settings } from '../shared/contracts';

export interface PersistedStats {
  affection: number;
  mood: number;
  todayInteractions: number;
  totalCompanionMs: number;
  lastInteractionDate: string;
  dailyInteractionDates: Record<string, string>;
  lastMoodDecayMs: number;
}

export const MAX_TIMER_DELAY_MS = 2_147_000_000;
// 桌宠大小自由调整，允许 50%-150% 范围内的任意缩放值
export const PET_SCALE_MIN = 0.5;
export const PET_SCALE_MAX = 1.5;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`Invalid ${label}`);
  return value as Record<string, unknown>;
}

export function localDateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function parseSettings(value: unknown): Settings {
  const obj = record(value, 'settings');
  const expected = new Set(['edgeSnap', 'alwaysOnTop', 'typingReaction', 'clickThrough', 'petScale', 'autoStart', 'autoStartInit', 'randomWalk']);
  for (const key of Object.keys(obj)) if (!expected.has(key)) throw new TypeError(`Unknown settings field: ${key}`);
  for (const key of ['edgeSnap', 'alwaysOnTop', 'typingReaction', 'clickThrough', 'autoStart', 'randomWalk'] as const) {
    if (typeof obj[key] !== 'boolean') throw new TypeError(`Invalid settings field: ${key}`);
  }
  // autoStartInit 兼容旧数据：缺失视为已配置（保持旧行为，不改变既有自启状态）
  if (obj.autoStartInit !== undefined && typeof obj.autoStartInit !== 'boolean') throw new TypeError('Invalid settings field: autoStartInit');
  if (typeof obj.petScale !== 'number' || !Number.isFinite(obj.petScale) || obj.petScale < PET_SCALE_MIN || obj.petScale > PET_SCALE_MAX) {
    throw new TypeError('Invalid settings field: petScale');
  }
  return {
    edgeSnap: obj.edgeSnap as boolean,
    alwaysOnTop: obj.alwaysOnTop as boolean,
    typingReaction: obj.typingReaction as boolean,
    clickThrough: obj.clickThrough as boolean,
    petScale: obj.petScale,
    autoStart: obj.autoStart as boolean,
    autoStartInit: obj.autoStartInit === undefined ? true : (obj.autoStartInit as boolean),
    randomWalk: obj.randomWalk as boolean,
  };
}

export function parsePersistedStats(value: unknown): PersistedStats {
  const obj = record(value, 'stats');
  const finite = (key: keyof PersistedStats, min: number, max = Number.MAX_SAFE_INTEGER) => {
    const item = obj[key];
    if (typeof item !== 'number' || !Number.isFinite(item) || item < min || item > max) throw new TypeError(`Invalid stats field: ${key}`);
    return item;
  };
  const lastInteractionDate = obj.lastInteractionDate;
  if (typeof lastInteractionDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(lastInteractionDate)) {
    throw new TypeError('Invalid stats field: lastInteractionDate');
  }
  const todayInteractions = finite('todayInteractions', 0);
  if (!Number.isInteger(todayInteractions)) throw new TypeError('Invalid stats field: todayInteractions');
  const dailyInteractionDates = obj.dailyInteractionDates && typeof obj.dailyInteractionDates === 'object'
    ? obj.dailyInteractionDates as Record<string, string>
    : {};
  const lastMoodDecayMs = typeof obj.lastMoodDecayMs === 'number' ? obj.lastMoodDecayMs : Date.now();
  return {
    affection: finite('affection', 0, 100),
    mood: finite('mood', 0, 100),
    todayInteractions,
    totalCompanionMs: finite('totalCompanionMs', 0),
    lastInteractionDate,
    dailyInteractionDates,
    lastMoodDecayMs,
  };
}

export function parseReminders(value: unknown): Reminder[] {
  if (!Array.isArray(value)) throw new TypeError('Invalid reminders');
  return value.map((item) => {
    const obj = record(item, 'reminder');
    if (typeof obj.id !== 'string' || obj.id.length < 1 || obj.id.length > 100) throw new TypeError('Invalid reminder id');
    if (typeof obj.text !== 'string' || obj.text.trim().length < 1 || obj.text.length > 500) throw new TypeError('Invalid reminder text');
    if (typeof obj.dueAt !== 'string' || !Number.isFinite(Date.parse(obj.dueAt))) throw new TypeError('Invalid reminder dueAt');
    if (typeof obj.createdAt !== 'string' || !Number.isFinite(Date.parse(obj.createdAt))) throw new TypeError('Invalid reminder createdAt');
    return { id: obj.id, text: obj.text, dueAt: obj.dueAt, createdAt: obj.createdAt };
  });
}

export function parseQuotes(value: unknown): Record<string, string[]> {
  const obj = record(value, 'quotes');
  const out: Record<string, string[]> = {};
  for (const [key, item] of Object.entries(obj)) {
    if (key.length < 1 || key.length > 50) throw new TypeError('Invalid quotes key');
    if (!Array.isArray(item) || item.length > 200) throw new TypeError('Invalid quotes list');
    for (const q of item) {
      if (typeof q !== 'string' || q.length > 200) throw new TypeError('Invalid quote text');
    }
    out[key] = item as string[];
  }
  return out;
}

export function nextReminderDelay(dueAt: string, now = Date.now()): number {
  return Math.min(MAX_TIMER_DELAY_MS, Math.max(0, Date.parse(dueAt) - now));
}
