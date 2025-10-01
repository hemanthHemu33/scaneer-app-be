// dynamicRiskModel.js
// Provides dynamic risk management utilities for trading strategies
import { validateRR as baseValidateRR } from './riskValidator.js';
import { DEFAULT_MARGIN_PERCENT } from './util.js';
import { riskDefaults } from './riskConfig.js';

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
 * @param {number} [opts.qtyStep=1] - Minimum tradable quantity increment
 * @param {number} [opts.tickSize] - Deprecated alias for qtyStep
 * @param {number} [opts.volatility] - Volatility metric (e.g. ATR)
 * @param {number} [opts.capUtil=0.05] - Legacy capital utilization cap per trade
 * @param {number} [opts.price=entry] - Price used for margin estimation
 * @param {number} [opts.leverage=0] - Available leverage multiplier
 * @param {number} [opts.marginPercent] - Broker-provided margin percentage (alternative to leverage)
 * @param {number} [opts.marginPerLot] - Explicit margin requirement per lot/step
 * @param {number} [opts.marginBuffer=1] - Safety buffer applied to margin
 * @param {number} [opts.exchangeMarginMultiplier=1] - Exchange-imposed multiplier
 * @param {number} [opts.utilizationCap] - Override for capital utilization when margin provided
 * @param {number} [opts.minQty] - Minimum allowable quantity
 * @param {number} [opts.maxQty] - Maximum allowable quantity
 * @returns {number} quantity
 */
export function calculateLotSize({
  capital,
  riskAmount = 0.01,
  entry,
  stopLoss,
  qtyStep = 1,
  tickSize,
  volatility,
  capUtil = 0.05,
  price = entry,
  leverage = 0,
  marginPercent,
  marginPerLot,
  marginBuffer = 1,
  exchangeMarginMultiplier = 1,
  utilizationCap,
  minQty,
  maxQty,
}) {
  if (!capital || !entry || !stopLoss) return 0;
  const sl = Math.abs(entry - stopLoss);
  if (sl <= 0) return 0;

  const risk = riskAmount <= 1 ? capital * riskAmount : riskAmount;
  let qty = risk / Math.max(sl, 1e-6);

  const stepInput =
    typeof tickSize === 'number' && !Number.isNaN(tickSize) ? tickSize : qtyStep;
  const step = typeof stepInput === 'number' && stepInput > 0 ? stepInput : 1;
  const roundDownToStep = (value) => {
    if (!Number.isFinite(value) || value <= 0) return 0;
    const scaled = value / step;
    const floored = Math.floor(scaled + 1e-9);
    return Number((floored * step).toFixed(8));
  };
  const roundUpToStep = (value) => {
    if (!Number.isFinite(value)) return Number(step.toFixed(8));
    if (value <= 0) return Number(step.toFixed(8));
    const scaled = value / step;
    const ceiled = Math.ceil(scaled - 1e-9);
    return Number((ceiled * step).toFixed(8));
  };

  if (volatility && entry) {
    const atrPct = (volatility / entry) * 100;
    if (atrPct > 2) {
      const factor = Math.min(atrPct / 2, 3);
      qty /= factor;
    }
  }

  qty = roundDownToStep(qty);

  const marginPct =
    typeof marginPercent === 'number'
      ? marginPercent
      : leverage > 0
      ? 1 / leverage
      : DEFAULT_MARGIN_PERCENT;
  const effPrice = price || entry;
  const marginMultiplier = (exchangeMarginMultiplier || 1) * (marginBuffer || 1);

  let maxCapQty = Infinity;
  const inferredMarginPerLot =
    (marginPerLot || (effPrice ? effPrice * step * marginPct : 0)) * marginMultiplier;
  if (inferredMarginPerLot > 0) {
    const cap = typeof utilizationCap === 'number' ? utilizationCap : capUtil;
    if (cap > 0) {
      const maxLots = Math.floor((capital * cap) / inferredMarginPerLot);
      const capQty = Number((maxLots * step).toFixed(8));
      maxCapQty = capQty;
      if (capQty <= 0) return 0;
      qty = Math.min(qty, capQty);
    }
  } else if (effPrice > 0) {
    const legacyMaxUnits = Math.floor((capital * capUtil) / effPrice);
    const capQty = roundDownToStep(legacyMaxUnits);
    maxCapQty = capQty;
    if (capQty <= 0) return 0;
    qty = Math.min(qty, capQty);
  }

  let minRounded;
  if (typeof minQty === 'number' && minQty > 0) {
    minRounded = roundUpToStep(minQty);
    if (maxCapQty < minRounded) return 0;
    if (qty < minRounded) qty = minRounded;
  }

  if (typeof maxQty === 'number' && maxQty > 0) {
    const maxRounded = roundDownToStep(maxQty);
    if (maxRounded <= 0) return 0;
    if (typeof minRounded === 'number' && minRounded > maxRounded) return 0;
    qty = Math.min(qty, maxRounded);
  }

  return qty > 0 ? qty : 0;
}

export function validateRR(args) {
  return baseValidateRR(args);
}

/**
 * Check exposure caps before placing a new trade.
 * @param {Object} opts
 * @param {Object|Map} opts.positions - Current open positions map { sym: { value, sector } }
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

  const getAll = () =>
    positions instanceof Map ? Array.from(positions.values()) : Object.values(positions || {});
  const getFor = (sym) => (positions instanceof Map ? positions.get(sym) : positions?.[sym]);

  const currentInst = getFor(instrument)?.value || 0;
  if (currentInst + tradeValue > instCap) return false;

  let currentSector = 0;
  for (const pos of getAll()) {
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
  if (typeof drawdown !== 'number') return lotSize;
  const halt = riskDefaults.drawdownHaltPct ?? 0.15;
  const cut50 = riskDefaults.drawdownReduce50Pct ?? 0.1;
  const cut25 = riskDefaults.drawdownReduce25Pct ?? 0.05;
  if (drawdown >= halt) return 0;
  if (drawdown >= cut50) return Math.floor(lotSize * 0.5);
  if (drawdown >= cut25) return Math.floor(lotSize * 0.75);
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
  const maxLs = riskDefaults.maxLossStreak ?? 3;
  if (lossStreak >= maxLs) return Math.floor(lotSize * 0.5);
  if (lossStreak === Math.max(1, maxLs - 1)) return Math.floor(lotSize * 0.75);
  return lotSize;
}

/**
 * Perform real-time risk recalculations.
 * @param {Object} opts
 * @param {number} opts.atr - Latest ATR
 * @param {number} opts.entry - Entry price
 * @param {string} opts.direction - Trade direction
 * @param {number} opts.capital - Account balance
 * @param {number} opts.risk - Risk per trade (percent or absolute)
 * @param {number} [opts.volatility] - Volatility metric
 * @param {number} [opts.qtyStep] - Quantity increment size
 * @param {number} [opts.leverage] - Broker leverage multiplier
 * @param {number} [opts.marginPercent] - Margin percentage
 * @param {number} [opts.marginPerLot] - Explicit margin per lot
 * @param {number} [opts.marginBuffer=1] - Margin safety buffer
 * @param {number} [opts.exchangeMarginMultiplier=1] - Exchange margin multiplier
 * @param {number} [opts.utilizationCap] - Capital utilization cap
 * @returns {Object} { stopLoss, qty }
 */
export function realTimeRiskController({
  atr,
  entry,
  direction,
  capital,
  risk,
  volatility,
  qtyStep,
  leverage = 0,
  marginPercent,
  marginPerLot,
  marginBuffer = 1,
  exchangeMarginMultiplier = 1,
  utilizationCap,
}) {
  const stopLoss = calculateDynamicStopLoss({ atr, entry, direction });
  const qty = calculateLotSize({
    capital,
    riskAmount: risk,
    entry,
    stopLoss,
    volatility,
    qtyStep,
    leverage,
    marginPercent,
    marginPerLot,
    marginBuffer,
    exchangeMarginMultiplier,
    utilizationCap,
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

