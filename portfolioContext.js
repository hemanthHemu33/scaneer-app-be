// portfolioContext.js
// Provides portfolio context management utilities
import db from './db.js';
import { sendNotification } from './telegram.js';
import { applyRealizedPnL } from './account.js';
import { ensureClock } from './src/backtest/clock.js';

export const openPositions = new Map(); // symbol -> position object
const lastExitTime = new Map();
let activeClock = ensureClock();

function nowMs() {
  return activeClock.now();
}

function nowDate() {
  return new Date(nowMs());
}

export function setPortfolioClock(clockLike) {
  activeClock = ensureClock(clockLike);
}

export function resetPortfolioClock() {
  activeClock = ensureClock();
}

// --- helpers ---
function normSide(v) {
  const s = String(v || '').toLowerCase();
  if (s === 'buy' || s === 'long' || s === 'b' || s === '1') return 'buy';
  if (s === 'sell' || s === 'short' || s === 's' || s === '-1') return 'sell';
  return 'buy';
}

function upsertLivePositionDoc(p) {
  return { ...p, updatedAt: nowDate() };
}

/**
 * Persist current open positions to MongoDB collection 'live_positions'.
 * @param {Object} [cache=db] - Database instance
 */
export async function saveLivePositions(cache = db) {
  if (!cache?.collection) return;
  const col = cache.collection('live_positions');
  await col.deleteMany({});
  const docs = Array.from(openPositions.values()).map(upsertLivePositionDoc);
  if (docs.length) await col.insertMany(docs);
}

/**
 * Load open positions from MongoDB collection 'live_positions'.
 * @param {Object} [cache=db] - Database instance
 */
export async function loadLivePositions(cache = db) {
  if (!cache?.collection) return;
  const col = cache.collection('live_positions');
  const docs = await col.find({}).toArray();
  openPositions.clear();
  for (const p of docs) {
    const { _id, ...rest } = p;
    rest.side = normSide(rest.side);
    openPositions.set(rest.symbol, rest);
  }
}

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
    const qty = Number(p.qty ?? p.quantity ?? 0);
    const entry = Number(p.entryPrice ?? p.average_price ?? 0);
    const mark = Number(p.last_price ?? p.mark_price ?? p.ltp ?? p.close ?? 0);
    const position = {
      symbol,
      side: normSide(p.side || p.transaction_type || 'buy'),
      strategy: p.strategy || '',
      qty: Number.isFinite(qty) ? qty : 0,
      entryPrice: Number.isFinite(entry) ? entry : 0,
      markPrice: Number.isFinite(mark) && mark > 0 ? mark : undefined,
      sector: p.sector || 'GEN',
      updatedAt: nowDate(),
    };
    openPositions.set(symbol, position);
    docs.push(position);
  }
  if (cache?.collection) {
    const col = cache.collection('open_positions');
    await col.deleteMany({});
    if (docs.length) await col.insertMany(docs);
    const live = cache.collection('live_positions');
    await live.deleteMany({});
    if (docs.length) await live.insertMany(docs.map(upsertLivePositionDoc));
  }
}

function calculateExposure(symbol, sector, { markToMarket = false } = {}) {
  let gross = 0;
  let sectorExposure = 0;
  for (const p of openPositions.values()) {
    const px = markToMarket && p.markPrice ? p.markPrice : p.entryPrice;
    const value = px * p.qty;
    gross += value;
    if (p.sector === sector) sectorExposure += value;
  }
  const instPos = openPositions.get(symbol);
  const instPx = markToMarket && instPos?.markPrice ? instPos.markPrice : instPos?.entryPrice ?? 0;
  const instValue = instPos ? instPx * instPos.qty : 0;
  return { gross, sectorExposure, instValue };
}

function enforceExposureLimits({
  tradeValue,
  totalCapital,
  exposureCap,
  instrumentCap,
  reservePct,
  maxMarginPct,
  sectorCaps,
  sector,
  instValue,
  sectorExposure,
  gross,
}) {
  const newGross = gross + tradeValue;
  if (totalCapital) {
    const allowedExposure = totalCapital * exposureCap;
    const reserveLimit = totalCapital * (1 - reservePct);
    const marginLimit = totalCapital * maxMarginPct;
    if (newGross > allowedExposure) return false;
    if (newGross > reserveLimit) return false;
    if (newGross > marginLimit) return false;

    const instLimit = instrumentCap * totalCapital;
    if (instValue + tradeValue > instLimit) return false;

    const secLimit = (sectorCaps[sector] ?? 0.25) * totalCapital;
    if (sectorExposure + tradeValue > secLimit) return false;
  }
  return true;
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
  instrumentCap = 0.1,
  tradeCapPct = 0.1,
  reservePct = 0,
  maxMarginPct = 1,
  minTradeCapital = 0,
  maxTradeCapital = Infinity,
  priority = false,
  markToMarket = false,
}) {
  if (priority) return true;

  if (totalCapital) {
    if (tradeValue < minTradeCapital) return false;
    if (tradeValue > maxTradeCapital) return false;
    if (tradeValue > totalCapital * tradeCapPct) return false;
  }

  const { gross, sectorExposure, instValue } = calculateExposure(symbol, sector, { markToMarket });
  return enforceExposureLimits({
    tradeValue,
    totalCapital,
    exposureCap,
    instrumentCap,
    reservePct,
    maxMarginPct,
    sectorCaps,
    sector,
    instValue,
    sectorExposure,
    gross,
  });
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
  if (last && nowMs() - last < windowMs) return false;
  return true;
}

/**
 * Record new entry locally (use on fill/confirm).
 * Persist to 'live_positions' for continuity between process restarts.
 */
export async function recordEntry({
  symbol,
  side,
  qty,
  entryPrice,
  sector = 'GEN',
  strategy = '',
  markPrice,
}) {
  if (!symbol) return;
  const qtyNum = Math.max(1, Number(qty || 0));
  const entryNum = Number(entryPrice || 0);
  const markNum = Number(markPrice ?? entryNum);
  const position = {
    symbol,
    side: normSide(side),
    qty: Number.isFinite(qtyNum) ? qtyNum : 1,
    entryPrice: Number.isFinite(entryNum) ? entryNum : 0,
    sector,
    strategy,
    updatedAt: nowDate(),
  };
  if (Number.isFinite(markNum) && markNum > 0) {
    position.markPrice = markNum;
  }
  openPositions.set(symbol, position);
  await saveLivePositions().catch(() => {});
}

/**
 * Record exit of a position.
 * @param {string} symbol
 * @param {Object} [opts]
 * @param {number} [opts.exitPrice]
 * @param {number} [opts.qty] - if omitted, assumes full exit of recorded qty
 * @param {number} [opts.fees=0]
 * @param {string} [opts.reason]
 */
export async function recordExit(symbol, opts = {}) {
  lastExitTime.set(symbol, nowMs());
  const pos = openPositions.get(symbol);
  const { exitPrice, qty, fees = 0, reason = 'exit' } = opts;
  if (pos && typeof exitPrice === 'number') {
    const closeQty = Number(qty || pos.qty || 0);
    const entryPx = Number(pos.entryPrice);
    const dir = pos.side; // 'buy'|'sell'
    if (Number.isFinite(closeQty) && Number.isFinite(entryPx)) {
      const pnlPer = dir === 'buy' ? exitPrice - entryPx : entryPx - exitPrice;
      const realized = pnlPer * closeQty - (Number(fees) || 0);
      if (Number.isFinite(realized)) {
        applyRealizedPnL(realized);
      }
      if (sendNotification && Number.isFinite(pnlPer)) {
        sendNotification(
          `[EXIT] ${symbol} ${closeQty}@${exitPrice} ${reason} | PnL: ${Number.isFinite(realized) ? realized.toFixed(2) : 'NA'}`
        );
      }
    }
  }
  const qtyNum = Number(qty);
  if (pos && Number.isFinite(qtyNum) && qtyNum < pos.qty) {
    pos.qty = pos.qty - qtyNum;
    openPositions.set(symbol, { ...pos, updatedAt: nowDate() });
    if (db?.collection) {
      const col = db.collection('live_positions');
      await col.updateOne(
        { symbol },
        { $set: upsertLivePositionDoc(openPositions.get(symbol)) }
      );
    }
    return;
  }
  openPositions.delete(symbol);
  if (db?.collection) {
    const col = db.collection('live_positions');
    await col.deleteOne({ symbol }).catch(() => {});
  }
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
  if (existing.side === normSide(signal.side)) return true;
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
    const side = normSide(sig.side);
    openPositions.set(sig.symbol, {
      symbol: sig.symbol,
      side,
      qty: sig.qty || 1,
      entryPrice: sig.entryPrice,
      sector: sig.sector || 'GEN',
      strategy: sig.strategy || '',
    });
    exposureTimeline.push(getGrossExposure());
    if (typeof sig.exitPrice === 'number') {
      const pnl =
        (side === 'buy'
          ? sig.exitPrice - sig.entryPrice
          : sig.entryPrice - sig.exitPrice) * (sig.qty || 1);
      balance += pnl;
      recordExit(sig.symbol, { exitPrice: sig.exitPrice, qty: sig.qty || 1 }).catch(() => {});
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

export { getGrossExposure };

/**
 * Optional: update a position's live price for mark-to-market exposure checks.
 */
export function updateMarkPrice(symbol, markPrice) {
  const p = openPositions.get(symbol);
  if (!p) return;
  p.markPrice = Number(markPrice) || undefined;
  p.updatedAt = new Date();
  openPositions.set(symbol, p);
  if (db?.collection) {
    const col = db.collection('live_positions');
    col.updateOne({ symbol }, { $set: upsertLivePositionDoc(p) }).catch(() => {});
  }
}
