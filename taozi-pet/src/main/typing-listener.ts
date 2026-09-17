import type { TypingStatus } from '../shared/contracts';

/**
 * 键盘活动监听（features.typingReaction）的接入点：当前不装载原生键盘钩子，start() 恒返回不可用。
 * running 记录监听是否已启动，callback 承载键盘活动回调，二者供接入原生库后使用。
 */
export class TypingListener {
  private running = false;
  private callback: (() => void) | undefined;

  start(enabled: boolean, callback: () => void): TypingStatus {
    this.callback = callback;
    if (!enabled) {
      this.running = false;
      return { enabled: false, reason: 'disabled-by-settings' };
    }
    // 不实际监听键盘，只返回状态；完整实现需要原生键盘钩子库（如 uiohook-napi）
    this.running = false;
    return { enabled: false, reason: 'not-available' };
  }

  stop(): void {
    this.running = false;
    this.callback = undefined;
  }
}
