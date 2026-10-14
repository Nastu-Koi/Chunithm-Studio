import test from 'node:test';
import assert from 'node:assert/strict';
import { lowerBound, upperBound } from '../src/core/search';

test('upperBound and lowerBound bracket runs of equal keys', () => {
  const values = [0, 1, 1, 1, 3];
  const key = (value: number) => value;
  assert.equal(lowerBound(values, 1, key), 1);
  assert.equal(upperBound(values, 1, key), 4);
  assert.equal(lowerBound(values, 2, key), 4);
  assert.equal(upperBound(values, 2, key), 4);
  assert.equal(lowerBound(values, -1, key), 0);
  assert.equal(upperBound(values, 3, key), 5);
  assert.equal(upperBound([], 0, key), 0);
  assert.equal(
    upperBound([{ tick: 0 }, { tick: 96 }], 96, item => item.tick),
    2,
  );
});
