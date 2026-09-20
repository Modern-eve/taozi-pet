import test from 'node:test';
import assert from 'node:assert/strict';
import { CURSOR_BAND_PX, SNAP_BAND_PX } from '../../src/main/drag';
import { debugOverlayLayout, type DebugOverlayInput } from '../../src/main/overlay-layout';

const workArea = { x: 0, y: 0, width: 1440, height: 1000 };
const pet = { x: 600, y: 700, width: 240, height: 286 };

function input(overrides: Partial<DebugOverlayInput> = {}): DebugOverlayInput {
  return {
    visible: true,
    workArea,
    pet,
    scale: 0.8,
    characterWidth: 109,
    snapWidth: 220,
    bubble: null,
    snapEnabled: true,
    snapSide: null,
    snapBand: SNAP_BAND_PX,
    cursorBand: CURSOR_BAND_PX,
    walkEnabled: true,
    walkLevel: 2,
    walkRadius: 320,
    walkAnchor: { x: 600, y: 700 },
    ...overrides,
  };
}

test('unattached pet keeps the character centered inside its window', () => {
  const payload = debugOverlayLayout(input());
  // 窗口 240 宽、人物 109 宽 → 两侧各留 65.5，取整后 66/65
  assert.equal(payload.character.left, 666);
  assert.equal(payload.character.width, 109);
  assert.equal(payload.snap.side, null);
});

test('snapping puts the snap reference box on the edge, insetting a narrower character', () => {
  // 基准框 220（气泡实宽）宽于人物 109 → 人物落在框内，两侧各内缩 (220-109)/2 ≈ 56
  assert.equal(debugOverlayLayout(input({ snapSide: 'left' })).character.left, 56);
  assert.equal(debugOverlayLayout(input({ snapSide: 'right' })).character.left, 1440 - 109 - 56);
  // 人物宽于气泡时基准框就是人物本身，人物压在屏边上
  const wide = { characterWidth: 300, snapWidth: 300 };
  assert.equal(debugOverlayLayout(input({ ...wide, snapSide: 'left' })).character.left, 0);
  assert.equal(debugOverlayLayout(input({ ...wide, snapSide: 'right' })).character.left, 1440 - 300);
});

test('walk range circle is drawn at the pet body center, not the window corner', () => {
  const payload = debugOverlayLayout(input());
  // 身体 = 窗口底部 176px 的方形区域：纵向中心 = 700 + 286 - 88
  assert.deepEqual(payload.walk.center, { x: 666 + 55, y: 898 });
  assert.equal(payload.walk.radius, 320);
});

test('bubble box is translated from window-local to screen coordinates', () => {
  const payload = debugOverlayLayout(input({ bubble: { left: 0, top: 42, width: 148, height: 52 } }));
  assert.deepEqual(payload.bubble, { left: 600, top: 742, width: 148, height: 52 });
  assert.equal(debugOverlayLayout(input()).bubble, null);
});

test('level zero reports no walk range instead of a zero radius', () => {
  const payload = debugOverlayLayout(input({ walkEnabled: false, walkLevel: 0, walkRadius: null }));
  assert.equal(payload.walk.enabled, false);
  assert.equal(payload.walk.radius, null);
});
