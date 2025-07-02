import test from 'node:test';
import assert from 'node:assert/strict';

import { computeConfidenceScore } from '../confidence.js';

test('computeConfidenceScore blends factors', () => {
  const score = computeConfidenceScore({
    hitRate: 0.8,
    confirmations: 3,
    quality: 1,
    date: new Date('2023-01-01T10:00:00Z')
  });
  assert.ok(score > 0.7 && score <= 1);
});

test('computeConfidenceScore low factors', () => {
  const score = computeConfidenceScore({
    hitRate: 0.2,
    confirmations: 0,
    quality: 0.1,
    date: new Date('2023-01-01T15:00:00Z')
  });
  assert.ok(score < 0.5);
});
