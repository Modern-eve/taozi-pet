import type { PetStats } from '../shared/contracts';
import { broadcastToWindows } from './broadcast';
import type { MainContext } from './context';
import { localDateKey } from './data-validation';
import { atomicWriteJson } from './persistence';
import { userFile } from './runtime';

/** 对外暴露的统计口径：陪伴时长含本次会话尚未落盘的增量。 */
export function publicStats(ctx: MainContext): PetStats {
  const liveMs = ctx.stats.totalCompanionMs + Math.max(0, Date.now() - ctx.sessionStartedAt);
  return {
    affection: ctx.stats.affection,
    mood: ctx.stats.mood,
    todayInteractions: ctx.stats.todayInteractions,
    companionMinutes: Math.floor(liveMs / 60_000),
    lastInteractionDate: ctx.stats.lastInteractionDate,
  };
}

/** 跨天时清零当日互动计数。 */
export function normalizeStatsDay(ctx: MainContext): void {
  const today = localDateKey();
  if (ctx.stats.lastInteractionDate !== today) {
    ctx.stats.todayInteractions = 0;
    ctx.stats.lastInteractionDate = today;
  }
}

export async function persistStats(ctx: MainContext): Promise<void> {
  ctx.stats.totalCompanionMs += Math.max(0, Date.now() - ctx.sessionStartedAt);
  ctx.sessionStartedAt = Date.now();
  await atomicWriteJson(userFile('pet-stats.json'), ctx.stats);
}

/**
 * 结算一次增益：好感按来源每日仅首次计入（同日重复不再加），心情每次都计入；两者均封顶 100。
 * 只改内存状态，落盘与广播由调用方决定。
 */
export function applyReward(ctx: MainContext, source: string, gain: number): void {
  normalizeStatsDay(ctx);
  const today = localDateKey();
  if (ctx.stats.dailyInteractionDates[source] !== today) {
    ctx.stats.affection = Math.min(100, ctx.stats.affection + gain);
    ctx.stats.dailyInteractionDates[source] = today;
  }
  ctx.stats.mood = Math.min(100, ctx.stats.mood + gain);
}

export function broadcastStats(ctx: MainContext): void {
  broadcastToWindows(ctx, 'pet:stats', publicStats(ctx));
}
