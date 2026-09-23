import type { Settings } from '../shared/contracts';
import { STANDBY_SIGNAL } from '../shared/contracts';
import { broadcastToWindows } from './broadcast';
import type { MainContext } from './context';
import { atomicWriteJson } from './persistence';
import { startRandomWalk, stopRandomWalk } from './random-walk';
import { userFile } from './runtime';
import { applyAutoStart, applyPetSettings, sendActivity, stateForTrigger } from './windows';

/** 键盘反应的回退延时：抬起字母键后这么久没有再次按下，就把桌宠送回待机。 */
const TYPING_IDLE_MS = 3000;

/** 落盘并生效一份新设置：窗口几何、自启动、打字监听、随机行走、托盘菜单、广播。 */
export async function saveSettings(ctx: MainContext, next: Settings): Promise<Settings> {
  ctx.settings = next;
  await atomicWriteJson(userFile('settings.json'), ctx.settings);
  applyPetSettings(ctx);
  applyAutoStart(ctx);
  restartTypingListener(ctx);
  if (ctx.settings.randomWalk) startRandomWalk(ctx); else stopRandomWalk(ctx);
  ctx.hooks.refreshTrayMenu?.();
  broadcastToWindows(ctx, 'settings:changed', ctx.settings);
  return ctx.settings;
}

export function broadcastTypingStatus(ctx: MainContext): void {
  broadcastToWindows(ctx, 'typing:status', ctx.typingStatus);
}

export function restartTypingListener(ctx: MainContext): void {
  stopTypingListener(ctx);
  ctx.typingStatus = ctx.typingListener.start(ctx.settings.typingReaction, (action) => {
    if (action === 'release') {
      playTypingSegment(ctx, 'release');
      scheduleTypingIdle(ctx);
      return;
    }
    // 按下即撤销上一次抬起的回退，准备重新走一遍「按下段 → 抬起段」
    cancelTypingIdle(ctx);
    playTypingSegment(ctx, 'press');
  });
  broadcastTypingStatus(ctx);
  void ctx.logger?.write(ctx.typingStatus.enabled ? 'info' : 'warn', 'typing-listener-status', ctx.typingStatus as unknown as Record<string, unknown>);
}

/** 卸下键盘钩子并清掉待回退的定时器（设置变更与退出共用）。 */
export function stopTypingListener(ctx: MainContext): void {
  cancelTypingIdle(ctx);
  ctx.typingListener.stop();
}

/**
 * 下发按键反应的一段：按下播 press 段、抬起播 release 段，区间取自 spec 的 segments。
 * 播放时长不在这里派生——分段播完即定格在段末帧，由下一段或待机信号接管。
 */
function playTypingSegment(ctx: MainContext, phase: 'press' | 'release'): void {
  const state = stateForTrigger(ctx, 'typing:activity');
  // spec 缺该触发器时桌宠会毫无反应，故直接放弃并告警
  if (!state) {
    void ctx.logger?.write('warn', 'typing-trigger-missing', { trigger: 'typing:activity' });
    return;
  }
  const segment = state.segments?.[phase];
  if (!segment) {
    void ctx.logger?.write('warn', 'typing-segment-missing', { state: state.id, phase });
    return;
  }
  sendActivity(ctx, { kind: 'typing', stateId: state.id, segment });
}

function cancelTypingIdle(ctx: MainContext): void {
  if (ctx.typingIdleTimer === undefined) return;
  clearTimeout(ctx.typingIdleTimer);
  ctx.typingIdleTimer = undefined;
}

/**
 * 抬起后起算回退：超时仍停在键盘动作上才送回待机。
 * STANDBY_SIGNAL 走旁路、绕过全部打断名单，故必须确认没被 sleep / sad / 互动等接管。
 */
function scheduleTypingIdle(ctx: MainContext): void {
  cancelTypingIdle(ctx);
  ctx.typingIdleTimer = setTimeout(() => {
    ctx.typingIdleTimer = undefined;
    const state = stateForTrigger(ctx, 'typing:activity');
    if (!state || ctx.currentStateId !== state.id) return;
    sendActivity(ctx, { kind: 'typing-idle', stateId: STANDBY_SIGNAL });
  }, TYPING_IDLE_MS);
}
