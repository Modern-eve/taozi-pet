import test from 'node:test';
import assert from 'node:assert/strict';
import { PET_BUBBLE_ZONE, type PetSpec } from '../../src/shared/contracts';
import { inBubbleZone, inZone, type ZoneRect } from '../../src/renderer/pet/hit-area';
import { pickQuote } from '../../src/renderer/pet/quotes';

const spec = {
  experience: {
    quotes: {
      look: { quotes: ['看这里', '在呢'] },
      sad: { quotes: ['抱抱'] },
    },
  },
} as unknown as PetSpec;

test('built-in quotes are used when the user has not customised any', () => {
  assert.equal(pickQuote(spec, null, 'look', () => 0), '看这里');
  assert.equal(pickQuote(spec, {}, 'look', () => 0.999), '在呢');
  assert.equal(pickQuote(spec, {}, 'sad', () => 0), '抱抱');
});

test('custom quotes take precedence over the built-in list', () => {
  assert.equal(pickQuote(spec, { look: ['自定义'] }, 'look', () => 0), '自定义');
});

test('empty or missing quote groups yield an empty string', () => {
  assert.equal(pickQuote(spec, null, 'unknown-state', () => 0), '');
  assert.equal(pickQuote(spec, { look: [] }, 'unknown-state', () => 0), '');
  assert.equal(pickQuote(spec, { look: [''] }, 'look', () => 0), '看这里');
});

test('bubble zone swallows trusted clicks above the sprite only', () => {
  assert.equal(inBubbleZone(PET_BUBBLE_ZONE - 1, true), true);
  assert.equal(inBubbleZone(0, true), true);
  assert.equal(inBubbleZone(PET_BUBBLE_ZONE, true), false);
  assert.equal(inBubbleZone(PET_BUBBLE_ZONE + 40, true), false);
});

test('programmatic clicks bypass the bubble zone so probes keep working', () => {
  assert.equal(inBubbleZone(10, false), false);
  assert.equal(inBubbleZone(PET_BUBBLE_ZONE - 1, false), false);
  assert.equal(inBubbleZone(5, true, 4), false);
});

// 区域坐标按帧边长归一化，故用「帧内相对位置」表达边界，不依赖具体像素尺寸
const zone: ZoneRect = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 };
const frame = { left: 100, top: 200, size: 400 };

test('a point is inside a zone only within its normalised bounds', () => {
  const inside = { x: frame.left + zone.x * frame.size + 1, y: frame.top + zone.y * frame.size + 1 };
  const rightEdge = { x: frame.left + (zone.x + zone.width) * frame.size, y: inside.y };
  const bottomEdge = { x: inside.x, y: frame.top + (zone.y + zone.height) * frame.size };
  const pastRight = { x: rightEdge.x + 1, y: inside.y };
  const pastBottom = { x: inside.x, y: bottomEdge.y + 1 };
  const aboveTop = { x: inside.x, y: frame.top + zone.y * frame.size - 1 };
  const leftOfLeft = { x: frame.left + zone.x * frame.size - 1, y: inside.y };

  assert.equal(inZone(inside.x, inside.y, zone, frame), true);
  // 边界闭区间：区域的下缘/右缘本身算命中
  assert.equal(inZone(rightEdge.x, rightEdge.y, zone, frame), true);
  assert.equal(inZone(bottomEdge.x, bottomEdge.y, zone, frame), true);
  assert.equal(inZone(pastRight.x, pastRight.y, zone, frame), false);
  assert.equal(inZone(pastBottom.x, pastBottom.y, zone, frame), false);
  assert.equal(inZone(aboveTop.x, aboveTop.y, zone, frame), false);
  assert.equal(inZone(leftOfLeft.x, leftOfLeft.y, zone, frame), false);
});

test('zone hit test is scale invariant, so resizing the pet does not move the zone', () => {
  const half = { left: frame.left, top: frame.top, size: frame.size / 2 };
  const point = { x: frame.left + 0.4 * frame.size, y: frame.top + 0.4 * frame.size };
  assert.equal(inZone(point.x, point.y, zone, frame), true);
  assert.equal(inZone(half.left + 0.4 * half.size, half.top + 0.4 * half.size, zone, half), true);
});

test('a degenerate frame size never reports a hit', () => {
  assert.equal(inZone(0, 0, zone, { left: 0, top: 0, size: 0 }), false);
});
