import test from 'node:test';
import assert from 'node:assert/strict';

const kiteMock = test.mock.module('../kite.js', { namedExports: { getMA: () => null } });
const dbMock = test.mock.module('../db.js', {
  defaultExport: {},
  namedExports: { connectDB: async () => ({}) }
});

const { detectAllPatterns } = await import('../util.js');

kiteMock.restore();
dbMock.restore();

test('detectAllPatterns identifies Rounding Bottom', () => {
  const candles = [
    { open: 10.8, high: 11, low: 10, close: 10.2 },
    { open: 10.2, high: 10.5, low: 9.5, close: 9.8 },
    { open: 9.8, high: 10, low: 9, close: 9.5 },
    { open: 9.6, high: 10.4, low: 9.3, close: 10.1 },
    { open: 10.2, high: 11.2, low: 9.8, close: 11 }
  ];
  const patterns = detectAllPatterns(candles, 1, 5);
  const rb = patterns.find(p => p.type === 'Rounding Bottom');
  assert.ok(rb);
});

test('detectAllPatterns identifies Broadening Top', () => {
  const candles = [
    { open: 9, high: 9.2, low: 8.9, close: 9.1 },
    { open: 9.2, high: 9.4, low: 8.8, close: 9 },
    { open: 9.5, high: 10, low: 9, close: 9.8 },
    { open: 9.8, high: 11, low: 8.8, close: 9 },
    { open: 9, high: 12, low: 8, close: 8.5 }
  ];
  const patterns = detectAllPatterns(candles, 1, 5);
  const bt = patterns.find(p => p.type === 'Broadening Top');
  assert.ok(bt);
});

test('detectAllPatterns identifies Saucer Bottom', () => {
  const candles = [
    { open: 9.8, high: 10, low: 9.7, close: 9.9 },
    { open: 9.9, high: 10.1, low: 9.6, close: 9.8 },
    { open: 10, high: 10.2, low: 9, close: 9 },
    { open: 9.5, high: 9.7, low: 9, close: 9 },
    { open: 9.1, high: 10.5, low: 9, close: 10 }
  ];
  const patterns = detectAllPatterns(candles, 1, 5);
  const sb = patterns.find(p => p.type === 'Saucer Bottom');
  assert.ok(sb);
});

test('detectAllPatterns identifies HH-HL Structure', () => {
  const candles = [
    { open: 10, high: 10.5, low: 9.5, close: 10.2 },
    { open: 10.2, high: 10.8, low: 9.8, close: 10.6 },
    { open: 10.7, high: 11, low: 10.2, close: 10.9 }
  ];
  const patterns = detectAllPatterns(candles, 1, 3);
  const hh = patterns.find(p => p.type === 'HH-HL Structure');
  assert.ok(hh);
});

test('detectAllPatterns identifies Break of Structure (Bullish)', () => {
  const candles = [
    { open: 9.8, high: 10, low: 9.5, close: 9.8 },
    { open: 9.7, high: 9.9, low: 9.4, close: 9.6 },
    { open: 9.6, high: 9.8, low: 9.3, close: 9.7 },
    { open: 9.7, high: 9.9, low: 9.4, close: 9.8 },
    { open: 10, high: 10.5, low: 9.8, close: 10.6 }
  ];
  const patterns = detectAllPatterns(candles, 1, 5);
  const bos = patterns.find(p => p.type === 'Break of Structure (Bullish)');
  assert.ok(bos);
});

test('detectAllPatterns identifies Swing Failure Pattern (Bearish)', () => {
  const candles = [
    { open: 9.8, high: 10, low: 9.6, close: 9.9 },
    { open: 9.9, high: 10.2, low: 9.7, close: 10.1 },
    { open: 10.1, high: 10.5, low: 9.8, close: 10.1 }
  ];
  const patterns = detectAllPatterns(candles, 1, 3);
  const sfp = patterns.find(p => p.type === 'Swing Failure Pattern (Bearish)');
  assert.ok(sfp);
});

test('detectAllPatterns identifies Wolfe Wave (Bullish)', () => {
  const candles = [
    { open: 10, high: 10.2, low: 9.8, close: 10.1 },
    { open: 9.9, high: 10, low: 9.6, close: 9.7 },
    { open: 10, high: 10.3, low: 9.8, close: 10.2 },
    { open: 9.8, high: 10, low: 9.4, close: 9.6 },
    { open: 10.1, high: 10.6, low: 9.9, close: 10.5 }
  ];
  const patterns = detectAllPatterns(candles, 1, 5);
  const ww = patterns.find(p => p.type === 'Wolfe Wave (Bullish)');
  assert.ok(ww);
});

test('detectAllPatterns identifies Dead Cat Bounce', () => {
  const candles = [
    { open: 12, high: 12.1, low: 11.8, close: 12 },
    { open: 10.5, high: 10.8, low: 10.2, close: 10.4 },
    { open: 10.8, high: 11, low: 10.3, close: 10.8 },
    { open: 10.6, high: 10.7, low: 10.1, close: 10.2 }
  ];
  const patterns = detectAllPatterns(candles, 1, 4);
  const dcb = patterns.find(p => p.type === 'Dead Cat Bounce');
  assert.ok(dcb);
});

test('detectAllPatterns identifies Gap Fill Reversal (Bearish)', () => {
  const candles = [
    { open: 100, high: 101, low: 99, close: 100 },
    { open: 103, high: 104, low: 98, close: 99 }
  ];
  const patterns = detectAllPatterns(candles, 1, 2);
  const gfr = patterns.find(p => p.type === 'Gap Fill Reversal (Bearish)');
  assert.ok(gfr);
});

test('detectAllPatterns identifies Island Reversal Top', () => {
  const candles = [
    { open: 100, high: 101, low: 99, close: 100 },
    { open: 102, high: 103, low: 102, close: 102.5 },
    { open: 100, high: 100.5, low: 99.5, close: 100 }
  ];
  const patterns = detectAllPatterns(candles, 1, 3);
  const irt = patterns.find(p => p.type === 'Island Reversal Top');
  assert.ok(irt);
});

test('detectAllPatterns identifies Island Reversal Bottom', () => {
  const candles = [
    { open: 100, high: 101, low: 99, close: 100 },
    { open: 98, high: 98.5, low: 97.5, close: 98 },
    { open: 100, high: 101, low: 99.5, close: 100.5 }
  ];
  const patterns = detectAllPatterns(candles, 1, 3);
  const irb = patterns.find(p => p.type === 'Island Reversal Bottom');
  assert.ok(irb);
});

test('detectAllPatterns identifies Bull Trap After Gap Up', () => {
  const candles = [
    { open: 100, high: 101, low: 99, close: 101 },
    { open: 103, high: 104, low: 99, close: 100 }
  ];
  const patterns = detectAllPatterns(candles, 1, 2);
  const bt = patterns.find(p => p.type === 'Bull Trap After Gap Up');
  assert.ok(bt);
});

test('detectAllPatterns identifies Bear Trap After Gap Down', () => {
  const candles = [
    { open: 100, high: 101, low: 99, close: 99 },
    { open: 97, high: 100, low: 95, close: 99.5 }
  ];
  const patterns = detectAllPatterns(candles, 1, 2);
  const bt = patterns.find(p => p.type === 'Bear Trap After Gap Down');
  assert.ok(bt);
});
