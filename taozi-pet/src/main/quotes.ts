import { allQuoteGroups } from '../shared/quotes';
import type { MainContext } from './context';
import { broadcastToWindows } from './broadcast';
import { atomicWriteJson } from './persistence';
import { userFile } from './runtime';

/** 语录种子：全部语录文本统一定义在 pet-spec.json 的 experience.quotes（状态与互动同表）。
 * 首次启动据此生成 userData/quotes.json，之后语录页与桌宠都只读写这份运行时文件，
 * 编辑即同步。 */
export function initialQuotes(ctx: MainContext): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const group of allQuoteGroups(ctx.spec)) {
    if (group.quotes.length) out[group.key] = [...group.quotes];
  }
  return out;
}

export async function persistQuotes(ctx: MainContext): Promise<void> {
  await atomicWriteJson(userFile('quotes.json'), ctx.quotes);
}

/** 通知 pet 与 dashboard 刷新语录缓存（dashboard 为编辑方，自身即时更新）。 */
export function notifyQuotesChanged(ctx: MainContext): void {
  broadcastToWindows(ctx, 'quotes:changed');
}
