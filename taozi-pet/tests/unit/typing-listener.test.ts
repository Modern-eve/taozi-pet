import test from 'node:test';
import assert from 'node:assert/strict';
import { edgeForPress, edgeForRelease, TypingListener } from '../../src/main/typing-listener';

test('typing listener reports disabled settings explicitly', () => {
  const listener = new TypingListener();
  assert.deepEqual(listener.start(false, () => {}), { enabled: false, reason: 'disabled-by-settings' });
  listener.stop();
});

test('typing listener fails closed when the optional native provider is unavailable', () => {
  const listener = new TypingListener();
  const status = listener.start(true, () => {});
  assert.equal(status.enabled, false);
  assert.equal(status.reason, 'not-available');
  // 「不可用」必须带上底层原因，否则日志里只剩一个无从定位的结论
  assert.ok(status.detail, 'not-available 必须带上底层原因');
  assert.ok(status.detail.length > 0);
  listener.stop();
});

test('字母键按下只在「从无到有」时产生 press', () => {
  const held = new Set<number>();
  assert.equal(edgeForPress(held, 30), 'press');
  // 长按产生的连续重复 keydown 折叠成一次
  assert.equal(edgeForPress(held, 30), null);
  assert.equal(edgeForPress(held, 30), null);
  // 按住期间又按别的字母键：不是新的「开始敲键盘」，也不算一次 press
  assert.equal(edgeForPress(held, 48), null);
  assert.equal(held.size, 2);
});

test('所有按住的字母键都抬起才产生 release', () => {
  const held = new Set<number>();
  edgeForPress(held, 30);
  edgeForPress(held, 48);
  assert.equal(edgeForRelease(held, 30), null); // 还剩一个键按住
  assert.equal(edgeForRelease(held, 48), 'release');
  // 未按住的键抬起（事件乱序或重复）不产生动作
  assert.equal(edgeForRelease(held, 30), null);
  // 全部抬起后重新按下，可以再次触发
  assert.equal(edgeForPress(held, 30), 'press');
});

test('卸下钩子是幂等的，未启动时调用 stop 不报错', () => {
  const listener = new TypingListener();
  listener.stop();
  assert.equal(listener.start(true, () => {}).reason, 'not-available');
  listener.stop();
  listener.stop();
});
