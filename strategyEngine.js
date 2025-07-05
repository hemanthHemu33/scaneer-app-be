import { calculateEMA, calculateRSI, calculateSupertrend } from './featureEngine.js';

export function strategySupertrend({ candles }) {
  if (!Array.isArray(candles) || candles.length < 20) return null;
  const closes = candles.map(c => c.close);
  const rsi = calculateRSI(closes, 14);
  const st = calculateSupertrend(candles, 10);
  const last = candles[candles.length - 1];
  if (st?.signal === 'Buy' && rsi > 55) {
    return {
      name: 'Supertrend',
      direction: 'Long',
      entry: last.close,
      stopLoss: last.low,
      confidence: 0.6,
    };
  }
  if (st?.signal === 'Sell' && rsi < 45) {
    return {
      name: 'Supertrend',
      direction: 'Short',
      entry: last.close,
      stopLoss: last.high,
      confidence: 0.6,
    };
  }
  return null;
}

export function strategyEMAReversal({ candles }) {
  if (!Array.isArray(candles) || candles.length < 20) return null;
  const closes = candles.map(c => c.close);
  const ema20 = calculateEMA(closes, 20);
  const ema50 = calculateEMA(closes, 50);
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  if (prev.close < ema20 && last.close > ema20 && ema20 > ema50) {
    return {
      name: 'EMA Reversal',
      direction: 'Long',
      entry: last.close,
      stopLoss: prev.low,
      confidence: 0.55,
    };
  }
  if (prev.close > ema20 && last.close < ema20 && ema20 < ema50) {
    return {
      name: 'EMA Reversal',
      direction: 'Short',
      entry: last.close,
      stopLoss: prev.high,
      confidence: 0.55,
    };
  }
  return null;
}

export function evaluateAllStrategies(context = {}) {
  return [
    strategySupertrend(context),
    strategyEMAReversal(context),
    // Add more strategy calls here
  ].filter(Boolean);
}
