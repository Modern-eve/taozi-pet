import type { Settings } from '../shared/contracts';
import { broadcastToWindows } from './broadcast';
import type { MainContext } from './context';
import { atomicWriteJson } from './persistence';
import { startRandomWalk, stopRandomWalk } from './random-walk';
import { userFile } from './runtime';
import { applyAutoStart, applyPetSettings, sendActivity, stateForTrigger } from './windows';

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
  ctx.typingListener.stop();
  ctx.typingStatus = ctx.typingListener.start(ctx.settings.typingReaction, () => {
    const state = stateForTrigger(ctx, 'typing:activity');
    // spec 缺该触发器时静默失败（stateId 为 undefined 会让桌宠毫无反应），这里直接放弃并告警
    if (!state) {
      void ctx.logger?.write('warn', 'typing-trigger-missing', { trigger: 'typing:activity' });
      return;
    }
    // 时长由状态实际帧长派生，不硬编码，保证动画完整播完
    const durationMs = state.frames.length * state.frameDurationMs;
    // 至少等上一次反应播完再响应，避免高频击键打断动画
    const now = Date.now();
    if (now - ctx.lastTypingReactionAt < durationMs) return;
    ctx.lastTypingReactionAt = now;
    sendActivity(ctx, { kind: 'typing', stateId: state.id, durationMs });
  });
  broadcastTypingStatus(ctx);
  void ctx.logger?.write(ctx.typingStatus.enabled ? 'info' : 'warn', 'typing-listener-status', ctx.typingStatus as unknown as Record<string, unknown>);
}
