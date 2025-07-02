// confidence.js

// In-memory strategy statistics { symbol: { strategy: { wins, trades } } }
export const strategyStats = {};

export function recordStrategyResult(symbol, strategy, win) {
  if (!strategyStats[symbol]) strategyStats[symbol] = {};
  const stat = strategyStats[symbol][strategy] || { wins: 0, trades: 0 };
  stat.trades += 1;
  if (win) stat.wins += 1;
  strategyStats[symbol][strategy] = stat;
}

export function getStrategyHitRate(symbol, strategy) {
  const stat = strategyStats[symbol]?.[strategy];
  if (!stat || stat.trades === 0) return 0.5;
  return stat.wins / stat.trades;
}

export function timeOfDayScore(date = new Date()) {
  const h = date.getHours() + date.getMinutes() / 60;
  if (h >= 9 && h < 11) return 1; // early session
  if (h >= 11 && h < 14) return 0.8;
  return 0.6; // later in the day
}

export function confirmationScore(count = 0) {
  return Math.min(count / 3, 1); // saturate at 3
}

export function signalQualityScore({ atr, rvol }) {
  const atrScore = Math.min(atr / 2, 1); // ATR around 2 considered strong
  const volumeScore = Math.min(rvol / 2, 1); // RVOL 2 or higher is strong
  return (atrScore + volumeScore) / 2;
}

export function computeConfidenceScore({
  hitRate = 0.5,
  date = new Date(),
  confirmations = 0,
  quality = 0.5,
} = {}) {
  const score =
    hitRate * 0.4 +
    timeOfDayScore(date) * 0.2 +
    confirmationScore(confirmations) * 0.2 +
    quality * 0.2;
  return Math.max(0, Math.min(score, 1));
}
