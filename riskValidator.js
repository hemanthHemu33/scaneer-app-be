// riskValidator.js
// Provides pre-execution risk validation utilities
import { logSignalRejected } from './auditLogger.js';

export function getMinRRForStrategy(strategy, winrate = 0) {
  const s = (strategy || '').toLowerCase();
  switch (s) {
    case 'trend-following':
    case 'trend':
      return 2;
    case 'breakout':
      return 1.8;
    case 'mean-reversion':
      return 1.5;
    case 'scalping':
    case 'fade':
      return winrate > 0.65 ? 1.2 : Infinity;
    case 'news':
    case 'news-event':
    case 'news/event setups':
      return 2;
    default:
      return 1.5;
  }
}

export function validateRR({ strategy, entry, stopLoss, target, winrate = 0 }) {
  const risk = Math.abs(entry - stopLoss);
  if (!risk) return { valid: false, rr: 0, minRR: Infinity };
  const rr = Math.abs((target - entry) / risk);
  const minRR = getMinRRForStrategy(strategy, winrate);
  return { valid: rr >= minRR, rr, minRR };
}

export function adjustStopLoss({ price, stopLoss, direction, atr, structureBreak = false }) {
  let newSL = stopLoss;
  const thresh = atr * 0.5;
  if (structureBreak) {
    return direction === 'Long' ? Math.max(stopLoss, price) : Math.min(stopLoss, price);
  }
  if (direction === 'Long') {
    if (price - stopLoss > thresh) {
      newSL = Math.max(stopLoss, price - thresh);
    }
  } else {
    if (stopLoss - price > thresh) {
      newSL = Math.min(stopLoss, price + thresh);
    }
  }
  return newSL;
}

export function isSLInvalid({ price, stopLoss, atr, structureBreak = false }) {
  if (structureBreak) return true;
  const proximity = Math.abs(price - stopLoss);
  return proximity <= atr * 0.2;
}

export function checkMarketConditions({
  atr,
  avgAtr,
  indexTrend,
  signalDirection,
  timeSinceSignal = 0,
  volume,
  spread,
  newsImpact = false,
  eventActive = false,
}) {
  if (avgAtr && atr > avgAtr * 1.5) return false;
  if (indexTrend && signalDirection && indexTrend !== signalDirection) return false;
  if (timeSinceSignal > 2 * 60 * 1000) return false;
  if (typeof spread === 'number' && spread > 0.3) return false;
  if (typeof volume === 'number' && volume <= 0) return false;
  if (newsImpact || eventActive) return false;
  return true;
}

export function validatePreExecution(signal, market) {
  const { strategy } = signal.algoSignal || { strategy: signal.pattern };
  const rrInfo = validateRR({
    strategy,
    entry: signal.entry,
    stopLoss: signal.stopLoss,
    target: signal.target2,
    winrate: market.winrate || 0,
  });
  if (!rrInfo.valid) {
    console.log(
      `[RISK] ${signal.stock || signal.symbol} RR ${rrInfo.rr.toFixed(2)} below ${rrInfo.minRR}`
    );
    logSignalRejected(
      signal.signalId || signal.algoSignal?.signalId,
      'rRTooLow',
      { rr: rrInfo.rr, minRR: rrInfo.minRR }
    );
    return false;
  }

  if (
    isSLInvalid({
      price: market.currentPrice ?? signal.entry,
      stopLoss: signal.stopLoss,
      atr: signal.atr,
      structureBreak: market.structureBreak,
    })
  ) {
    console.log(`[RISK] ${signal.stock || signal.symbol} stop-loss invalid`);
    logSignalRejected(
      signal.signalId || signal.algoSignal?.signalId,
      'slInvalid',
      { price: market.currentPrice ?? signal.entry, stopLoss: signal.stopLoss }
    );
    return false;
  }

  if (
    !checkMarketConditions({
      atr: signal.atr,
      avgAtr: market.avgAtr,
      indexTrend: market.indexTrend,
      signalDirection: signal.direction === 'Long' ? 'up' : 'down',
      timeSinceSignal: market.timeSinceSignal,
      volume: market.volume,
      spread: signal.spread,
      newsImpact: market.newsImpact,
      eventActive: market.eventActive,
    })
  ) {
    console.log(`[RISK] ${signal.stock || signal.symbol} market conditions fail`);
    logSignalRejected(
      signal.signalId || signal.algoSignal?.signalId,
      'conflict',
      { market }
    );
    return false;
  }

  return true;
}
