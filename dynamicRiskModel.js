// dynamicRiskModel.js
// Provides dynamic risk management utilities for trading strategies
import { validateRR as baseValidateRR } from './riskValidator.js';

/**
 * Calculate dynamic stop-loss based on ATR and setup confidence.
 * @param {Object} opts
 * @param {number} opts.atr - Current ATR value
 * @param {number} opts.entry - Entry price
 * @param {'Long'|'Short'} opts.direction - Trade direction
 * @param {'conservative'|'breakout'|'high'} [opts.setupType='conservative'] - Setup confidence
 * @returns {number} stop loss price
 */
export function calculateDynamicStopLoss({
  atr,
  entry,
  direction,
  setupType = 'conservative',
}) {
  if (!atr || !entry || !direction) return null;
  const mult = setupType === 'breakout' || setupType === 'high' ? 2 : 1.5;
  const dist = atr * mult;
  return direction === 'Long' ? entry - dist : entry + dist;
}

/**
 * Calculate lot size using capital based risk allocation.
 * @param {Object} opts
 * @param {number} opts.capital - Total capital
 * @param {number} [opts.riskAmount=0.01] - Risk per trade (percentage or absolute)
 * @param {number} opts.entry - Entry price
 * @param {number} opts.stopLoss - Stop loss price
 * @param {number} [opts.tickSize=1] - Minimum tick/lot size
 * @param {number} [opts.volatility] - Volatility metric to scale size
 * @param {number} [opts.capUtil=0.05] - Capital utilization cap per trade
 * @returns {number} quantity
 */
export function calculateLotSize({
  capital,
  riskAmount = 0.01,
  entry,
  stopLoss,
  tickSize = 1,
  volatility,
  capUtil = 0.05,
}) {
  if (!capital || !entry || !stopLoss) return 0;
  const sl = Math.abs(entry - stopLoss);
  if (sl <= 0) return 0;

  const risk = riskAmount <= 1 ? capital * riskAmount : riskAmount;
  let qty = risk / sl;

  if (volatility && volatility > 2) {
    const factor = Math.min(volatility / 2, 3);
    qty /= factor;
  }

  qty = Math.floor(qty / tickSize) * tickSize;
  const maxQty = Math.floor((capital * capUtil) / entry);
  if (maxQty > 0) qty = Math.min(qty, maxQty);
  return qty;
}

export function validateRR(args) {
  return baseValidateRR(args);
}

/**
 * Check exposure caps before placing a new trade.
 * @param {Object} opts
 * @param {Object} opts.positions - Current open positions map { sym: { value, sector } }
 * @param {string} opts.instrument - Instrument symbol
 * @param {string} opts.sector - Instrument sector
 * @param {number} opts.tradeValue - Value of the potential trade
 * @param {number} opts.totalCapital - Total trading capital
 * @param {Object} opts.caps - Exposure caps { instrument, sector: { default, ...sectorCaps } }
 * @returns {boolean} whether trade is allowed
 */
export function checkExposureCap({
  positions = {},
  instrument,
  sector,
  tradeValue,
  totalCapital,
  caps = {},
}) {
  const instCap = (caps.instrument || 0.1) * totalCapital;
  const secCaps = { default: 0.25, ...(caps.sector || {}) };
  const secCap = (secCaps[sector] ?? secCaps.default) * totalCapital;

  const currentInst = positions[instrument]?.value || 0;
  if (currentInst + tradeValue > instCap) return false;

  let currentSector = 0;
  for (const pos of Object.values(positions)) {
    if (pos.sector === sector) currentSector += pos.value;
  }
  if (currentSector + tradeValue > secCap) return false;
  return true;
}

/**
 * Adjust lot size when drawdown thresholds are breached.
 * @param {Object} opts
 * @param {number} opts.drawdown - Current drawdown percentage (0-1)
 * @param {number} opts.lotSize - Proposed lot size
 * @returns {number} adjusted lot size
 */
export function adjustRiskBasedOnDrawdown({ drawdown, lotSize }) {
  if (drawdown > 0.1) return 0;
  if (drawdown > 0.05) return Math.floor(lotSize * 0.5);
  return lotSize;
}

/**
 * Scale down lot size when a losing streak occurs.
 * @param {Object} opts
 * @param {number} opts.lossStreak - Consecutive losing trades
 * @param {number} opts.lotSize - Proposed lot size
 * @returns {number} adjusted lot size
 */
export function adjustRiskAfterLossStreak({ lossStreak = 0, lotSize }) {
  if (lossStreak >= 3) return Math.floor(lotSize * 0.5);
  if (lossStreak === 2) return Math.floor(lotSize * 0.75);
  return lotSize;
}

/**
 * Perform real-time risk recalculations.
 * @param {Object} opts
 * @param {number} opts.atr - Latest ATR
 * @param {number} opts.entry - Entry price
 * @param {string} opts.direction - Trade direction
 * @param {number} opts.capital - Account balance
 * @param {number} opts.risk - Risk per trade
 * @param {number} [opts.volatility] - Volatility metric
 * @returns {Object} { stopLoss, qty }
 */
export function realTimeRiskController({
  atr,
  entry,
  direction,
  capital,
  risk,
  volatility,
}) {
  const stopLoss = calculateDynamicStopLoss({ atr, entry, direction });
  const qty = calculateLotSize({
    capital,
    riskAmount: risk,
    entry,
    stopLoss,
    volatility,
  });
  return { stopLoss, qty };
}

/**
 * Simple backtest runner for the risk model.
 * @param {Array} data - Array of { entry, direction, atr }
 * @param {Object} opts
 * @param {number} opts.capital - Starting capital
 * @param {number} opts.risk - Risk per trade
 * @returns {Object} metrics
 */
export function backtestRiskModel(data = [], { capital = 100000, risk = 0.01 } = {}) {
  let balance = capital;
  let maxDrawdown = 0;
  let peak = capital;
  for (const d of data) {
    const { stopLoss, qty } = realTimeRiskController({
      atr: d.atr,
      entry: d.entry,
      direction: d.direction,
      capital: balance,
      risk,
    });
    const sl = Math.abs(d.entry - stopLoss);
    balance -= sl * qty;
    if (balance > peak) peak = balance;
    const dd = (peak - balance) / peak;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }
  return { finalBalance: balance, maxDrawdown };
}

