import test from 'node:test';
import assert from 'node:assert/strict';
import { PET_BUBBLE_ZONE, type PetSpec } from '../../src/shared/contracts';
import { inBubbleZone } from '../../src/renderer/pet/hit-area';
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
