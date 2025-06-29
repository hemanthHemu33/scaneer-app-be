// portfolioContext.js
// Provides portfolio context management utilities
import db from './db.js';
import { sendNotification } from './telegram.js';

export const openPositions = new Map(); // symbol -> position object
const lastExitTime = new Map();

/**
 * Refresh open positions from broker API and store in DB cache.
 * @param {Object} broker - Broker API with getPositions()
 * @param {Object} [cache=db] - Database instance
 */
export async function trackOpenPositions(broker, cache = db) {
  if (!broker?.getPositions) return;
  const pos = await broker.getPositions();
  openPositions.clear();
  const docs = [];
  for (const p of pos || []) {
    const symbol = p.symbol || p.tradingsymbol;
    if (!symbol) continue;
    const position = {
      symbol,
      side: p.side || p.transaction_type || 'Long',
      strategy: p.strategy || '',
      qty: p.qty || p.quantity || 0,
      entryPrice: p.entryPrice || p.average_price || 0,
      sector: p.sector || 'GEN',
      updatedAt: new Date(),
    };
    openPositions.set(symbol, position);
    docs.push(position);
  }
  if (cache?.collection) {
    const col = cache.collection('open_positions');
    await col.deleteMany({});
    if (docs.length) await col.insertMany(docs);
  }
}

/**
 * Check if new trade breaches exposure limits.
 * @param {Object} opts
 * @param {string} opts.symbol
 * @param {number} opts.tradeValue
 * @param {string} opts.sector
 * @param {number} opts.totalCapital
 * @param {Object} [opts.sectorCaps]
 * @param {number} [opts.exposureCap=0.75]
 * @param {boolean} [opts.priority=false]
 */
export function checkExposureLimits({
  symbol,
  tradeValue = 0,
  sector = 'GEN',
  totalCapital = 0,
  sectorCaps = {},
  exposureCap = 0.75,
  priority = false,
}) {
  if (priority) return true;
  let gross = 0;
  let sectorExposure = 0;
  for (const p of openPositions.values()) {
    const value = p.entryPrice * p.qty;
    gross += value;
    if (p.sector === sector) sectorExposure += value;
  }
  const newGross = gross + tradeValue;
  if (totalCapital && newGross > totalCapital * exposureCap) return false;
  const secLimit = (sectorCaps[sector] ?? 0.25) * totalCapital;
  if (totalCapital && sectorExposure + tradeValue > secLimit) return false;
  return true;
}

/**
 * Block re-entry within specified window after exit.
 * @param {string} symbol
 * @param {number} [windowMs=900000]
 * @returns {boolean} allowed
 */
export function preventReEntry(symbol, windowMs = 15 * 60 * 1000) {
  if (openPositions.has(symbol)) return false;
  const last = lastExitTime.get(symbol);
  if (last && Date.now() - last < windowMs) return false;
  return true;
}

/**
 * Record exit of a position.
 * @param {string} symbol
 */
export function recordExit(symbol) {
  lastExitTime.set(symbol, Date.now());
  openPositions.delete(symbol);
}

const strategyRank = {
  'trend-following': 3,
  trend: 3,
  reversal: 2,
  'mean-reversion': 1,
};

/**
 * Resolve conflicts between new signal and existing positions.
 * @param {Object} signal - { symbol, side, strategy }
 * @returns {boolean} allowed
 */
export function resolveSignalConflicts(signal) {
  const existing = openPositions.get(signal.symbol);
  if (!existing) return true;
  if (existing.side === signal.side) return true;
  const newPr = strategyRank[signal.strategy?.toLowerCase()] || 0;
  const exPr = strategyRank[existing.strategy?.toLowerCase()] || 0;
  return newPr > exPr;
}

/**
 * Send exposure related notifications.
 * @param {string} message
 */
export function notifyExposureEvents(message) {
  if (sendNotification) sendNotification(message);
  else console.log(message);
}

/**
 * Simple portfolio context backtest.
 * @param {Array} signals - array of {symbol, side, entryPrice, exitPrice, qty, sector}
 * @param {Object} opts - { capital, reentryWindowMs, sectorCaps, exposureCap }
 * @returns {Object}
 */
export function backtestPortfolioContext(signals = [], opts = {}) {
  const {
    capital = 100000,
    reentryWindowMs = 15 * 60 * 1000,
    sectorCaps = {},
    exposureCap = 0.75,
  } = opts;
  let balance = capital;
  openPositions.clear();
  lastExitTime.clear();
  const exposureTimeline = [];
  for (const sig of signals) {
    const tradeValue = sig.entryPrice * (sig.qty || 1);
    if (
      !preventReEntry(sig.symbol, reentryWindowMs) ||
      !checkExposureLimits({
        symbol: sig.symbol,
        tradeValue,
        sector: sig.sector || 'GEN',
        totalCapital: balance,
        sectorCaps,
        exposureCap,
      }) ||
      !resolveSignalConflicts(sig)
    ) {
      continue;
    }
    openPositions.set(sig.symbol, {
      symbol: sig.symbol,
      side: sig.side,
      qty: sig.qty || 1,
      entryPrice: sig.entryPrice,
      sector: sig.sector || 'GEN',
      strategy: sig.strategy || '',
    });
    exposureTimeline.push(getGrossExposure());
    if (typeof sig.exitPrice === 'number') {
      const pnl =
        (sig.exitPrice - sig.entryPrice) * (sig.qty || 1) *
        (sig.side === 'short' ? -1 : 1);
      balance += pnl;
      recordExit(sig.symbol);
    }
  }
  const finalExposure = getGrossExposure();
  return { balance, exposureTimeline, finalExposure };
}

function getGrossExposure() {
  let gross = 0;
  for (const p of openPositions.values()) {
    gross += p.entryPrice * p.qty;
  }
  return gross;
}
