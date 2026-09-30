import test from 'node:test';
import assert from 'node:assert/strict';
import { PET_BUBBLE_ZONE } from '../../src/shared/contracts';
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
    clickZones: {},
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

test('sprite frame is the bottom square of the window, taller than the character range', () => {
  const payload = debugOverlayLayout(input());
  // 精灵方框 = 贴底正方形，边长 = 窗口高 - 气泡区高；横向居中于窗口，与人物可见范围无关
  const size = pet.height - PET_BUBBLE_ZONE;
  assert.deepEqual(payload.sprite, { left: pet.x + (pet.width - size) / 2, top: pet.y + PET_BUBBLE_ZONE, size });
  // 人物可见范围窄于精灵方框，两者左缘不重合
  assert.ok(payload.character.width < payload.sprite.size);
  assert.notEqual(payload.character.left, payload.sprite.left);
});

test('click zones map their normalized box onto the sprite frame', () => {
  const zone = { stateId: 'pet-head', referenceStateId: 'standby-gap', x: 0.25, y: 0.5, width: 0.5, height: 0.25 };
  const payload = debugOverlayLayout(input({ clickZones: { head: zone } }));
  // 窗口 240 宽、286 高 → 精灵方框边长 176、左缘 600 + (240-176)/2 = 632、上缘 700 + 110 = 810
  assert.deepEqual(payload.clickZones, [{
    id: 'head',
    stateId: 'pet-head',
    rect: { left: 632 + 176 * 0.25, top: 810 + 176 * 0.5, width: 176 * 0.5, height: 176 * 0.25 },
  }]);
  assert.deepEqual(debugOverlayLayout(input()).clickZones, []);
});

test('click zones follow the sprite frame rather than the snapped character range', () => {
  // 热点区锚在精灵方框上：贴边改变的是「人物可见范围」，方框本身不受影响
  const zone = { stateId: 'pet-head', referenceStateId: 'standby-gap', x: 0, y: 0, width: 1, height: 1 };
  const detached = debugOverlayLayout(input({ clickZones: { head: zone } }));
  const snapped = debugOverlayLayout(input({ clickZones: { head: zone }, snapSide: 'left' }));
  assert.notDeepEqual(snapped.character, detached.character);
  assert.deepEqual(snapped.clickZones, detached.clickZones);
  // 方框随窗口移动：窗口左移多少，热点区就左移多少
  const moved = debugOverlayLayout(input({ clickZones: { head: zone }, pet: { ...pet, x: 0 } }));
  const [baseBox] = detached.clickZones;
  const [movedBox] = moved.clickZones;
  assert.ok(baseBox && movedBox);
  assert.equal(movedBox.rect.left, baseBox.rect.left - pet.x);
});
