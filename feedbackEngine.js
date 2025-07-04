import db from './db.js';

// Track strategy weights and historical performance
const weights = new Map();
const stats = new Map(); // { strategy: { wins, trades } }

export function updateStrategyWeight(name, delta) {
  const w = weights.get(name) ?? 1;
  const nw = Math.max(0.1, Math.min(w + delta, 2));
  weights.set(name, nw);
}

export function getStrategyWeight(name) {
  return weights.get(name) ?? 1;
}

export function adjustWeights(results = []) {
  for (const r of results) {
    updateStrategyWeight(r.strategy, r.outcome > 0 ? 0.1 : -0.1);
  }
}

/**
 * Record the outcome of a signal/trade for learning purposes.
 * @param {Object} signal - Signal info with `pattern` or `strategy` name
 * @param {number} result - Positive for win, negative for loss
 */
export async function recordSignalOutcome(signal = {}, result = 0) {
  const strategy = signal.pattern || signal.strategy || signal.name;
  if (!strategy) return;

  // Persist outcome when db connection available
  try {
    if (db?.collection) {
      await db.collection('signal_results').insertOne({
        strategy,
        symbol: signal.stock || signal.symbol,
        result,
        timestamp: new Date(),
      });
    }
  } catch (_) {
    /* ignore db errors in lightweight environments */
  }

  const stat = stats.get(strategy) || { wins: 0, trades: 0 };
  stat.trades += 1;
  if (result > 0) stat.wins += 1;
  stats.set(strategy, stat);

  updateStrategyWeight(strategy, result > 0 ? 0.1 : -0.1);
}

/**
 * Adjust signal confidence based on historical win rate.
 */
export function adjustConfidence(signal = {}) {
  const strategy = signal.pattern || signal.strategy || signal.name;
  if (!strategy) return signal;
  const stat = stats.get(strategy);
  if (!stat || stat.trades === 0) return signal;
  const winRate = stat.wins / stat.trades;
  const factor = 1 + (winRate - 0.5); // ranges roughly 0.5 - 1.5
  if (typeof signal.confidence === 'number') {
    signal.confidence = Math.max(0, Math.min(signal.confidence * factor, 1));
  }
  return signal;
}

/**
 * Determine if a strategy should be temporarily throttled
 * based on poor win rate.
 */
export function shouldThrottle(name, minTrades = 5) {
  const stat = stats.get(name);
  if (!stat || stat.trades < minTrades) return false;
  const winRate = stat.wins / stat.trades;
  return winRate < 0.4;
}

// Exported for tests
export function _getStats() {
  return stats;
}
