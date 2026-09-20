import test from 'node:test';
import assert from 'node:assert/strict';
import { CURSOR_BAND_PX, SNAP_BAND_PX, classifySnapSide, draggedBounds, exceedsDragThreshold, snappedBounds } from '../../src/main/drag';

test('drag begins only at the four-pixel movement threshold', () => {
  assert.equal(exceedsDragThreshold({ x: 10, y: 10 }, { x: 13, y: 10 }), false);
  assert.equal(exceedsDragThreshold({ x: 10, y: 10 }, { x: 14, y: 10 }), true);
  assert.equal(exceedsDragThreshold({ x: 0, y: 0 }, { x: 3, y: 3 }), true);
});

test('dragged bounds preserve size and apply rounded cursor delta', () => {
  assert.deepEqual(
    draggedBounds({ x: 100, y: 200, width: 256, height: 256 }, { x: 10, y: 10 }, { x: 27.6, y: 4.4 }),
    { x: 118, y: 194, width: 256, height: 256 },
  );
});

test('snap detection bounds the reference box on both sides', () => {
  const workArea = { x: 0, y: 0, width: 1440, height: 1000 };
  // 贴边基准框（缩放 0.5 时 220 × 220），起始位置远离两侧
  const reference = { x: 400, y: 300, width: 220, height: 220 };
  const at = (x: number) => classifySnapSide({ ...reference, x }, workArea);

  // 基准框缘与工作区缘的距离决定是否贴边，边界由 SNAP_BAND_PX 给出
  assert.equal(at(SNAP_BAND_PX - 1), 'left');
  assert.equal(at(SNAP_BAND_PX + 1), null);
  const rightAligned = workArea.width - reference.width;
  assert.equal(at(rightAligned - (SNAP_BAND_PX - 1)), 'right');
  assert.equal(at(rightAligned - (SNAP_BAND_PX + 1)), null);

  // 光标带独立生效：基准框缘还远，光标贴住屏边即算贴边意图
  assert.equal(classifySnapSide(reference, workArea, { x: CURSOR_BAND_PX - 1, y: 300 }), 'left');
  assert.equal(classifySnapSide(reference, workArea, { x: CURSOR_BAND_PX + 1, y: 300 }), null);

  // 判定带比工作区还宽时两侧同时命中，视为未贴边（不随机贴一侧）
  assert.equal(
    classifySnapSide({ x: SNAP_BAND_PX - 1, y: 300, width: workArea.width, height: 220 }, workArea),
    null,
  );
});

test('snapped bounds overshoot off-screen so the snap reference box meets the work-area edge', () => {
  const workArea = { x: 0, y: 0, width: 1440, height: 1000 };
  // 基准框在窗口内水平居中：基准框在窗口内的偏移 inset 要从窗口位置里扣掉
  const bounds = { x: -66, y: 742, width: 240, height: 286 };
  const inset = 65;
  const referenceWidth = 110;
  const left = snappedBounds(bounds, workArea, 'left', inset, referenceWidth);
  assert.deepEqual(left, { x: -65, y: 742, width: 240, height: 286 });
  // 基准框左缘正好落在工作区左缘 ⇒ 窗口向屏外过冲了 inset
  assert.equal(left.x + inset, workArea.x);
  const right = snappedBounds(bounds, workArea, 'right', inset, referenceWidth);
  assert.deepEqual(right, { x: 1265, y: 742, width: 240, height: 286 });
  assert.equal(right.x + inset + referenceWidth, workArea.x + workArea.width);
  // 未贴边：位置原样保留；上下边缘不吸附，仅左右
  assert.deepEqual(
    snappedBounds({ ...bounds, y: 8 }, workArea, null, inset, referenceWidth),
    { x: -66, y: 8, width: 240, height: 286 },
  );
  // 基准框宽度就等于窗口宽度时无需偏移，窗口缘即基准框缘
  assert.deepEqual(
    snappedBounds({ x: 12, y: 742, width: 256, height: 256 }, workArea, 'left'),
    { x: 0, y: 742, width: 256, height: 256 },
  );
});
