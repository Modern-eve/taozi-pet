import type { TypingStatus } from '../shared/contracts';

/** 键盘监听到的字母键动作：press = 有字母键从无到有按下，release = 已按住的字母键全部抬起。 */
export type TypingKeyAction = 'press' | 'release';

type UiHookModule = typeof import('uiohook-napi');

/** 参与打字反应的字母键（A–Z）：数字、符号、功能键与修饰键一律忽略。 */
const LETTER_KEY_NAMES = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

/**
 * 记一次字母键按下，返回本次该上报的动作。
 * 只有「按住集合由空变非空」才算 press：长按产生的连续重复 keydown 由此折叠成一次，
 * 同时按住多个键时也只有第一个键产生 press。
 */
export function edgeForPress(held: Set<number>, keycode: number): TypingKeyAction | null {
  const wasIdle = held.size === 0;
  const isNew = !held.has(keycode);
  held.add(keycode);
  return wasIdle && isNew ? 'press' : null;
}

/**
 * 记一次字母键抬起，返回本次该上报的动作。
 * 只有「按住集合清空」才算 release：同时按住多个键时逐个抬起不会来回触发。
 */
export function edgeForRelease(held: Set<number>, keycode: number): TypingKeyAction | null {
  if (!held.delete(keycode)) return null;
  return held.size === 0 ? 'release' : null;
}

/**
 * 键盘活动监听（features.typingReaction）：装载原生全局键盘钩子，把字母键的按下与抬起上报给回调。
 * 原生模块不参与打包（见 webpack.main.config.js 的 externals），按 Node 规则在运行时解析；
 * 未安装或启动失败时退回「不可用」，不影响应用其余部分。
 */
export class TypingListener {
  private running = false;
  private callback: ((action: TypingKeyAction) => void) | undefined;
  /** 当前按住的字母键码：交给 edgeForPress / edgeForRelease 做边沿判定 */
  private readonly pressed = new Set<number>();
  private hook: UiHookModule['uIOhook'] | undefined;
  private letterCodes: Set<number> | undefined;

  private readonly handleKeyDown = (event: { keycode: number }): void => {
    if (!this.letterCodes?.has(event.keycode)) return;
    const action = edgeForPress(this.pressed, event.keycode);
    if (action) this.callback?.(action);
  };

  private readonly handleKeyUp = (event: { keycode: number }): void => {
    if (!this.letterCodes?.has(event.keycode)) return;
    const action = edgeForRelease(this.pressed, event.keycode);
    if (action) this.callback?.(action);
  };

  start(enabled: boolean, callback: (action: TypingKeyAction) => void): TypingStatus {
    this.callback = callback;
    if (!enabled) {
      this.detach();
      return { enabled: false, reason: 'disabled-by-settings' };
    }
    if (this.running) return { enabled: true, reason: 'running' };
    const loaded = loadHookModule();
    if ('error' in loaded) {
      this.detach();
      return { enabled: false, reason: 'not-available', detail: loaded.error };
    }
    const hookModule = loaded.module;
    if (!this.letterCodes) {
      this.letterCodes = new Set(
        LETTER_KEY_NAMES.map((name) => hookModule.UiohookKey[name as keyof typeof hookModule.UiohookKey]),
      );
    }
    this.hook = hookModule.uIOhook;
    this.pressed.clear();
    try {
      this.hook.on('keydown', this.handleKeyDown);
      this.hook.on('keyup', this.handleKeyUp);
      this.hook.start();
    } catch (error) {
      this.detach();
      return { enabled: false, reason: 'start-failed', detail: firstLine(error) };
    }
    this.running = true;
    return { enabled: true, reason: 'running' };
  }

  stop(): void {
    this.detach();
    this.callback = undefined;
  }

  /** 卸下钩子并清空按住状态；未启动时是空操作，可重复调用。 */
  private detach(): void {
    this.running = false;
    this.pressed.clear();
    const hook = this.hook;
    this.hook = undefined;
    if (!hook) return;
    hook.off('keydown', this.handleKeyDown);
    hook.off('keyup', this.handleKeyUp);
    try {
      hook.stop();
    } catch {
      // 钩子未真正启动时 stop 会抛，忽略即可
    }
  }
}

/** 装载原生键盘钩子的结果：成功给出模块，失败给出可读原因。 */
type HookLoadResult = { module: UiHookModule } | { error: string };

/** 只取首行：原生模块的报错常带多行调用栈与解析细节，整段塞进日志与状态页会淹没关键信息。 */
function firstLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split('\n')[0]?.trim() || 'unknown error';
}

/** 解析原生键盘钩子模块；未安装或加载失败时给出原因。 */
function loadHookModule(): HookLoadResult {
  try {
    const loaded = __non_webpack_require__('uiohook-napi') as UiHookModule;
    if (!loaded?.uIOhook) return { error: 'uiohook-napi 未导出 uIOhook' };
    return { module: loaded };
  } catch (error) {
    return { error: firstLine(error) };
  }
}
