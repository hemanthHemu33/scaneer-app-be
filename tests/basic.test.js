import test from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';

test('basic arithmetic', () => {
  assert.strictEqual(1 + 1, 2);
});
