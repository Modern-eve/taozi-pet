import test from 'node:test';
import assert from 'node:assert/strict';
import specData from '../../pet-spec.json';
import type { PetSpec } from '../../src/shared/contracts';
import { allQuoteGroups, pickQuote } from '../../src/shared/quotes';

const spec = specData as PetSpec;

test('quote groups come from the spec table, keyed by state id, once each', () => {
  const keys = allQuoteGroups(spec).map((group) => group.key);
  assert.deepEqual(keys, Object.keys(spec.experience.quotes));
  assert.equal(new Set(keys).size, keys.length);
});

test('every interaction speaks the quote group of its own state', () => {
  for (const interaction of spec.experience.interactions) {
    assert.equal(interaction.id, interaction.stateId);
    assert.notEqual(pickQuote(spec, null, interaction.id), '', `互动 ${interaction.id} 取不到语录`);
  }
});
