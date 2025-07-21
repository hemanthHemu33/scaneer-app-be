let trailingPct = 0.5;

export function setTrailingPercent(pct) {
  trailingPct = pct;
}

export function getTrailingStop(entry, direction, atr = 0) {
  const pctDist = entry * (trailingPct / 100);
  const dist = atr || pctDist;
  return direction === 'Long' ? entry - dist : entry + dist;
}

/**
 * Update trailing stop on the position and return true if stop triggered.
 * @param {Object} position - {side, entryPrice, stopLoss, lastPrice}
 * @returns {boolean} exit due to stop hit
 */
export function applyTrailingSL(position) {
  if (!position || typeof position.lastPrice !== 'number') return false;
  const dist = position.atr || (position.entryPrice * (trailingPct / 100));
  if (position.side === 'Long' || position.side === 'long') {
    position.highest = Math.max(position.highest ?? position.entryPrice, position.lastPrice);
    const sl = position.highest - dist;
    if (!position.stopLoss || sl > position.stopLoss) position.stopLoss = sl;
    return position.lastPrice <= position.stopLoss;
  }
  position.lowest = Math.min(position.lowest ?? position.entryPrice, position.lastPrice);
  const sl = position.lowest + dist;
  if (!position.stopLoss || sl < position.stopLoss) position.stopLoss = sl;
  return position.lastPrice >= position.stopLoss;
}

/**
 * Force exit based on holding duration.
 * @param {Object} position - {openTime, maxHoldMs}
 * @returns {boolean}
 */
export function forceTimeExit(position) {
  if (!position?.openTime) return false;
  const hold = Date.now() - position.openTime;
  const max = position.maxHoldMs ?? 30 * 60 * 1000; // default 30 min
  return hold >= max;
}

/**
 * Detect simple price reversal using last 3 prices.
 * @param {Object} position - {side, history: number[]}
 * @returns {boolean}
 */
export function detectReversalExit(position) {
  const hist = position?.history || [];
  if (hist.length < 3) return false;
  const [p3, p2, p1] = hist.slice(-3);
  if (position.side === 'Long' || position.side === 'long') {
    return p1 < p2 && p2 < p3;
  }
  return p1 > p2 && p2 > p3;
}

export function checkExitConditions(position) {
  if (applyTrailingSL(position)) return { shouldExit: true, reason: 'TrailingStop' };
  if (forceTimeExit(position)) return { shouldExit: true, reason: 'TimeBased' };
  if (detectReversalExit(position)) return { shouldExit: true, reason: 'Reversal' };
  return { shouldExit: false, reason: null };
}

export function shouldExit(signal, price, timeHeldMs) {
  if (!signal) return false;
  const slHit = signal.direction === 'Long' ? price <= signal.stopLoss : price >= signal.stopLoss;
  if (slHit) return true;
  if (signal.expiresAt && Date.now() > new Date(signal.expiresAt).getTime()) return true;
  return false;
}

/**
 * Start periodic exit checks on a collection of active trades.
 * @param {Iterable|Map} activeTrades - array or Map of open trades
 * @param {Object} handlers
 * @param {Function} [handlers.exitTrade]
 * @param {Function} [handlers.logTradeExit]
 * @param {number} [handlers.intervalMs]
 * @returns {NodeJS.Timeout}
 */
let monitorHandle = null;

export function startExitMonitor(
  activeTrades,
  { exitTrade, logTradeExit, intervalMs = 60 * 1000 } = {}
) {
  if (!activeTrades) return null;
  if (monitorHandle) clearInterval(monitorHandle);
  monitorHandle = setInterval(() => {
    const trades = activeTrades instanceof Map ? activeTrades.values() : activeTrades;
    for (const openTrade of trades) {
      const exitSignal = checkExitConditions(openTrade);
      if (exitSignal.shouldExit) {
        if (exitTrade) exitTrade(openTrade, exitSignal.reason);
        if (logTradeExit) logTradeExit(openTrade, exitSignal.reason);
      }
    }
  }, intervalMs);
  return monitorHandle;
}

export function stopExitMonitor() {
  if (monitorHandle) {
    clearInterval(monitorHandle);
    monitorHandle = null;
  }
}
