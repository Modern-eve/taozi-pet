import type { MainContext } from './context';
import { sendActivity } from './windows';

/** 无互动多久后入睡 */
export const SLEEP_TRIGGER_MS = 3 * 60 * 1000;

export function isDraggingActive(ctx: MainContext): boolean {
  return ctx.dragSession !== undefined;
}

/** 用户主动动作（互动/拖动/开发者面板）才重置入睡计时；随机行走等自动行为不推迟入睡。 */
export function resetActivityTimer(ctx: MainContext): void {
  ctx.lastActivityTime = Date.now();
  if (ctx.sleepTimer) {
    clearTimeout(ctx.sleepTimer);
    ctx.sleepTimer = undefined;
  }
  scheduleSleep(ctx);
}

export function scheduleSleep(ctx: MainContext): void {
  if (ctx.sleepTimer) clearTimeout(ctx.sleepTimer);
  ctx.sleepTimer = setTimeout(() => {
    const elapsed = Date.now() - ctx.lastActivityTime;
    if (elapsed >= SLEEP_TRIGGER_MS && !isDraggingActive(ctx) && !ctx.randomWalkAnimTimer) {
      // durationMs:0 = 常驻（如同 notify），保持入睡直到被开心/互动/通知打断
      sendActivity(ctx, { kind: 'ambient', stateId: 'sleep', durationMs: 0 });
    } else {
      scheduleSleep(ctx);
    }
  }, SLEEP_TRIGGER_MS);
}
