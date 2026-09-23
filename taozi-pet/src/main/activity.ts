import type { InteractionResult, PetState } from '../shared/contracts';
import { isIdlePresentation, stateCanInterrupt } from '../shared/contracts';
import { broadcastToWindows } from './broadcast';
import type { MainContext } from './context';
import { localDateKey } from './data-validation';
import { checkMoodState } from './mood';
import { startRandomWalk, stopRandomWalk } from './random-walk';
import { ackPendingReminder } from './reminders';
import { resetActivityTimer } from './sleep';
import { broadcastStats, normalizeStatsDay, persistStats, publicStats } from './stats';
import { sendActivity } from './windows';

/**
 * 下发 activity 前预判渲染层会不会采纳，省掉注定被拒的下发。
 * 判据与渲染层共用 stateCanInterrupt / isIdlePresentation；currentStateId 由渲染层回报驱动，比对的就是实际在播状态。
 */
export function canTakeOver(ctx: MainContext, next: PetState, currentId: string): boolean {
  if (isIdlePresentation(ctx.spec.idleRotation, currentId)) return true;
  if (next.id === currentId) return next.interrupt !== 'resume';
  return stateCanInterrupt(next, currentId);
}

/**
 * 桌宠窗口回报的「实际在播状态」：currentStateId 的唯一更新源。渲染层掌握帧推进、轮播选择与间歇长度，
 * 是状态与时序的真源；主进程据此镜像事实，而不是记录「自己发过什么」——后者会让门控停在一个渲染层并未采纳的状态上。
 * 随机行走按边沿启停（理由见 random-walk.ts 的 startRandomWalk），故只在进入/离开待机的那一次回报上启停调度。
 */
export function applyReportedState(ctx: MainContext, stateId: string): void {
  if (stateId === ctx.currentStateId) return;
  const wasIdle = isIdlePresentation(ctx.spec.idleRotation, ctx.currentStateId);
  ctx.currentStateId = stateId;
  if (stateId === 'sleep') stopRandomWalk(ctx);
  else if (!wasIdle && isIdlePresentation(ctx.spec.idleRotation, stateId)) startRandomWalk(ctx);
  // 同步当前状态给小屋面板，供状态页头像随实际情绪切换
  broadcastToWindows(ctx, 'state:changed', stateId);
}

export async function triggerInteraction(ctx: MainContext, id: string): Promise<InteractionResult> {
  const interaction = ctx.spec.experience.interactions.find((item) => item.id === id);
  if (!interaction || !ctx.spec.features.interactions) throw new Error(`Unknown or disabled interaction: ${id}`);
  resetActivityTimer(ctx);
  normalizeStatsDay(ctx);
  const today = localDateKey();
  const alreadyToday = ctx.stats.dailyInteractionDates[id] === today;
  if (!alreadyToday) {
    ctx.stats.affection = Math.min(100, ctx.stats.affection + interaction.affectionGain);
    ctx.stats.dailyInteractionDates[id] = today;
  }
  ctx.stats.mood = Math.min(100, ctx.stats.mood + Math.max(1, Math.ceil(interaction.affectionGain / 2)));
  ctx.stats.todayInteractions += 1;
  // 互动语录以运行时语录（userData/quotes.json，与语录页编辑同步）为准
  const customList = ctx.quotes[interaction.id];
  const list = customList && customList.length > 0 ? customList : interaction.feedback;
  const feedback = list[Math.floor(Math.random() * list.length)] ?? interaction.label;
  await persistStats(ctx);
  const result: InteractionResult = { interaction, feedback, stats: publicStats(ctx) };
  // 用户触发互动即消费待处理的队首提醒；等本互动播完再播放下一条
  ackPendingReminder(ctx, interaction.durationMs);
  // 互动是用户主动动作：先停下随机行走（含移动定时器），避免桌宠一边播互动一边滑行。
  // 互动是一次性状态，播完由渲染层转入待机并回报，主进程据该回报恢复行走调度。
  stopRandomWalk(ctx);
  sendActivity(ctx, { kind: 'interaction', stateId: interaction.stateId, durationMs: interaction.durationMs, feedback });
  broadcastStats(ctx);
  // 互动结束后检查心情，若仍低于阈值则回到sad
  setTimeout(() => checkMoodState(ctx), interaction.durationMs + 200);
  return result;
}
