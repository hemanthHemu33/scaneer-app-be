import test from 'node:test';
import assert from 'node:assert/strict';

import { rankSignals } from '../signalRanker.js';
import { recordStrategyResult } from '../confidence.js';

const baseTime = new Date('2023-01-01T10:00:00Z');

// Build some strategy stats
recordStrategyResult('AAA', 'trend', true);
recordStrategyResult('BBB', 'trend', false);
recordStrategyResult('CCC', 'trend', true);

const signals = [
  {
    stock: 'AAA',
    pattern: 'trend',
    confidence: 'High',
    entry: 100,
    stopLoss: 99,
    target1: 104,
    patternStrength: 'strong',
    time: baseTime.toISOString(),
  },
  {
    stock: 'BBB',
    pattern: 'trend',
    confidence: 'Medium',
    entry: 100,
    stopLoss: 99,
    target1: 101,
    patternStrength: 'weak',
    time: baseTime.toISOString(),
  },
  {
    stock: 'CCC',
    pattern: 'trend',
    confidence: 'Low',
    entry: 100,
    stopLoss: 99,
    target1: 103,
    patternStrength: 'medium',
    time: baseTime.toISOString(),
  },
];

test('rankSignals returns top signal based on score', () => {
  const [top] = rankSignals(signals);
  assert.equal(top.stock, 'AAA');
});

test('rankSignals can return top N signals', () => {
  const topTwo = rankSignals(signals, 2);
  assert.equal(topTwo.length, 2);
  assert.equal(topTwo[0].stock, 'AAA');
  assert.ok(topTwo[0].score >= topTwo[1].score);
});
