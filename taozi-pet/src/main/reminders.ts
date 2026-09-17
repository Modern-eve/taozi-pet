import type { Reminder } from '../shared/contracts';
import { broadcastToWindows } from './broadcast';
import type { MainContext } from './context';
import { nextReminderDelay } from './data-validation';
import { atomicWriteJson } from './persistence';
import { userFile } from './runtime';
import { sendActivity, stateForTrigger } from './windows';

export function broadcastRemindersUpdated(ctx: MainContext): void {
  broadcastToWindows(ctx, 'reminders:updated');
}

export function clearReminderTimer(ctx: MainContext, id: string): void {
  const timer = ctx.reminderTimers.get(id);
  if (timer) clearTimeout(timer);
  ctx.reminderTimers.delete(id);
}

export function scheduleReminder(ctx: MainContext, reminder: Reminder): void {
  clearReminderTimer(ctx, reminder.id);
  const delay = nextReminderDelay(reminder.dueAt);
  ctx.reminderTimers.set(reminder.id, setTimeout(() => {
    ctx.reminderTimers.delete(reminder.id);
    if (Date.parse(reminder.dueAt) > Date.now()) {
      scheduleReminder(ctx, reminder);
      return;
    }
    // 到点入队：队首正在播报时，后续到点的仅排队等待，不打断当前播报（保证旧→新顺序）
    const wasIdle = ctx.pendingReminderQueue.length === 0;
    ctx.pendingReminderQueue.push(reminder);
    if (wasIdle) announceReminder(ctx, reminder);
  }, delay));
}

/** 播放一条提醒：notify 动作 + 气泡持续循环显示 */
export function announceReminder(ctx: MainContext, reminder: Reminder): void {
  const state = stateForTrigger(ctx, 'reminder:due');
  sendActivity(ctx, { kind: 'notify', stateId: state?.id, durationMs: 0, feedback: reminder.text });
}

/**
 * 用户点击桌宠或触发其他动作时，消费旧→新队列里的队首一条；
 * 若仍待消费，则等打断动画播完（afterMs）再播放下一条，避免一次性全部清空。
 */
export function ackPendingReminder(ctx: MainContext, afterMs = 0): boolean {
  const consumed = ctx.pendingReminderQueue.shift();
  if (!consumed) return false;
  ctx.reminders = ctx.reminders.filter((item) => item.id !== consumed.id);
  clearReminderTimer(ctx, consumed.id);
  if (ctx.nextAnnounceReminderTimer !== null) {
    clearTimeout(ctx.nextAnnounceReminderTimer);
    ctx.nextAnnounceReminderTimer = null;
  }
  if (ctx.pendingReminderQueue.length > 0) {
    const next = ctx.pendingReminderQueue[0]!;
    ctx.nextAnnounceReminderTimer = setTimeout(() => {
      ctx.nextAnnounceReminderTimer = null;
      announceReminder(ctx, next);
    }, Math.max(0, afterMs));
  }
  void persistReminders(ctx);
  broadcastRemindersUpdated(ctx);
  return true;
}

export async function persistReminders(ctx: MainContext): Promise<void> {
  await atomicWriteJson(userFile('reminders.json'), ctx.reminders);
}

/** 清空提醒与全部相关定时器（重置数据用）。 */
export function clearAllReminders(ctx: MainContext): void {
  for (const reminder of ctx.reminders) clearReminderTimer(ctx, reminder.id);
  ctx.reminders = [];
  ctx.pendingReminderQueue.length = 0;
  if (ctx.nextAnnounceReminderTimer !== null) {
    clearTimeout(ctx.nextAnnounceReminderTimer);
    ctx.nextAnnounceReminderTimer = null;
  }
}
