import type { MainContext } from './context';

/** 向 pet 与 dashboard 两个窗口广播一条 IPC 消息（窗口已销毁则跳过）。 */
export function broadcastToWindows(ctx: MainContext, channel: string, ...args: unknown[]): void {
  for (const window of [ctx.petWindow, ctx.dashboardWindow]) {
    if (window && !window.isDestroyed()) window.webContents.send(channel, ...args);
  }
}
