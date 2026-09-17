import { STANDBY_SIGNAL } from '../shared/contracts';
import type { MainContext } from './context';
import { broadcastStats, persistStats } from './stats';
import { sendActivity } from './windows';

/** 心情低于该值触发 sad */
export const MOOD_SAD_THRESHOLD = 25;

export function decayMood(ctx: MainContext): void {
  const now = Date.now();
  const elapsed = now - ctx.stats.lastMoodDecayMs;
  // 每2分钟衰减1点心情
  const accrued = Math.floor(elapsed / 120_000);
  // 封顶单次结算点数，避免长期静置/休眠唤醒后一次性暴跌（心情"突然跃变"）
  const decayPoints = Math.min(6, accrued);
  if (decayPoints > 0 && ctx.stats.mood > 0) {
    ctx.stats.mood = Math.max(0, ctx.stats.mood - decayPoints);
    ctx.stats.lastMoodDecayMs = now;
    broadcastStats(ctx);
    checkMoodState(ctx);
  } else if (decayPoints === 0) {
    // 静置不足一个结算周期：时间前进，纯粹提前刷新参考点，防止累积瞬间扣分
    ctx.stats.lastMoodDecayMs = now;
  }
}

/** 心情跨越阈值时切换 sad / 回待机。 */
export function checkMoodState(ctx: MainContext): void {
  if (ctx.stats.mood < MOOD_SAD_THRESHOLD && ctx.currentStateId !== 'sad') {
    // durationMs:0 = 常驻（如同 notify），心情未回升前持续沮丧，仅被 sleep/互动/通知打断
    sendActivity(ctx, { kind: 'ambient', stateId: 'sad', durationMs: 0 });
  } else if (ctx.stats.mood >= MOOD_SAD_THRESHOLD && ctx.currentStateId === 'sad') {
    sendActivity(ctx, { kind: 'ambient', stateId: STANDBY_SIGNAL });
  }
}

export function startMoodDecay(ctx: MainContext): void {
  if (ctx.moodDecayTimer) clearInterval(ctx.moodDecayTimer);
  ctx.moodDecayTimer = setInterval(() => {
    decayMood(ctx);
    void persistStats(ctx).catch(() => {});
  }, 60_000); // 每分钟检查一次
}

export function stopMoodDecay(ctx: MainContext): void {
  if (ctx.moodDecayTimer) {
    clearInterval(ctx.moodDecayTimer);
    ctx.moodDecayTimer = undefined;
  }
}
