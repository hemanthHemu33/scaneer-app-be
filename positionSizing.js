// positionSizing.js

import { calculateDynamicStopLoss, adjustRiskBasedOnDrawdown } from './dynamicRiskModel.js';
import { adjustStopLoss } from './riskValidator.js';
import { DEFAULT_MARGIN_PERCENT } from './util.js';

// Default risk to reward ratio used for target calculations
export const RISK_REWARD_RATIO = 1.5;

let tradeCount = 0;

// --- Position Sizing Models ---

export function fixedRupeeRiskModel({ riskAmount, slPoints }) {
  if (!riskAmount || !slPoints) return 0;
  return riskAmount / slPoints;
}

export function fixedPercentRiskModel({ capital, riskPercent = 0.01, slPoints }) {
  if (!capital || !slPoints) return 0;
  return (capital * riskPercent) / slPoints;
}

export function kellyCriterionSize({ capital, winRate, winLossRatio, slPoints, fraction = 1 }) {
  if (!capital || !slPoints || !winRate || !winLossRatio) return 0;
  const k = winRate - (1 - winRate) / winLossRatio;
  if (k <= 0) return 0;
  return ((capital * k * fraction) / slPoints);
}

export function volatilityWeightedSize({
  capital,
  baseRisk = 0.01,
  volatility,
  benchmarkVolatility = volatility,
  slPoints,
}) {
  if (!capital || !slPoints || !volatility) return 0;
  const weight = benchmarkVolatility ? benchmarkVolatility / volatility : 1;
  return ((capital * baseRisk * weight) / slPoints);
}

export function equalCapitalAllocation({ capital, numPositions = 1, price }) {
  if (!capital || !price || numPositions <= 0) return 0;
  return (capital / numPositions) / price;
}

export function equalRiskAllocation({ capital, numPositions = 1, slPoints }) {
  if (!capital || !slPoints || numPositions <= 0) return 0;
  return (capital / numPositions) / slPoints;
}

export function confidenceBasedSizing({ baseQty, confidence = 1, maxConfidence = 1 }) {
  if (!baseQty) return 0;
  const conf = Math.min(confidence, maxConfidence);
  return baseQty * conf;
}

export function atrBasedSizing({ capital, atr, atrMult = 1, riskPercent = 0.01 }) {
  if (!capital || !atr) return 0;
  const sl = atr * atrMult;
  return ((capital * riskPercent) / sl);
}

export function dollarVolatilitySizing({ capital, atr, price, riskPercent = 0.01 }) {
  if (!capital || !atr || !price) return 0;
  const dv = atr * price;
  return ((capital * riskPercent) / dv);
}

/**
 * Calculate tradable quantity based on risk parameters.
 * Supports optional volatility and margin considerations.
 *
 * @param {Object} opts
 * @param {number} opts.capital            Total trading capital available.
 * @param {number} [opts.risk=0.01]        Risk per trade. If <=1 treated as percentage of capital, otherwise absolute amount.
 * @param {number} opts.slPoints           Stop loss distance in points.
 * @param {number} [opts.price]            Entry price used for margin estimation.
 * @param {number} [opts.volatility]       Instrument volatility (e.g. ATR).
 * @param {number} [opts.vix]              Market volatility index.
 * @param {number} [opts.lotSize=1]        Minimum tradable lot size.
 * @param {number} [opts.utilizationCap=1] Max portion of capital to allocate when marginPerLot is provided.
 * @param {number} [opts.minLotSize]       Minimum allowable quantity for F&O instruments.
 * @param {boolean} [opts.roundToLot=true] Whether to round quantity down to nearest lot.
 * @param {number} [opts.marginPerLot]     Margin required per lot. Defaults to Zerodha intraday policy if price is supplied.
 * @param {number} [opts.marginPercent]    Broker margin percentage (if not using leverage).
 * @param {number} [opts.leverage]         Leverage multiplier available from broker.
 * @param {number} [opts.marginBuffer=1]   Safety buffer on required margin.
 * @param {number} [opts.exchangeMarginMultiplier=1] Exchange specified margin multiplier.
 * @param {number} [opts.costBuffer=1]     Buffer for taxes and slippage.
 * @param {number} [opts.volatilityGuard]  ATR/VIX threshold beyond which position size is scaled down.
 * @param {Object} [opts.marketDepth]      Current market depth { buy, sell }.
 * @param {number} [opts.priceMovement]    Recent price movement for dynamic scaling.
 * @param {string} [opts.method]           Optional sizing method ('fixed-rupee', 'fixed-percent', 'kelly',
 *                                         'volatility-weighted', 'equal-capital', 'equal-risk',
 *                                         'confidence', 'atr', 'dollar-volatility').
 * Additional fields may be required based on the chosen method (e.g. winRate).
 */
export function calculatePositionSize({
  capital,
  risk = 0.01,
  slPoints,
  price,
  volatility,
  vix,
  lotSize = 1,
  utilizationCap = 1,
  minLotSize,
  roundToLot = true,
  marginPerLot,
  marginPercent,
  leverage = 0,
  marginBuffer = 1,
  exchangeMarginMultiplier = 1,
  costBuffer = 1,
  volatilityGuard,
  marketDepth,
  priceMovement,
  minQty,
  maxQty,
  method,
  winRate,
  winLossRatio,
  fraction = 1,
  benchmarkVolatility,
  numPositions,
  confidence,
  atrMult = 1,
}) {
  if (!capital) return 0;
  const methodName = method || 'default';
  if (!slPoints && !['equal-capital'].includes(methodName) && !['equal-risk'].includes(methodName)) return 0;

  tradeCount += 1;
  if (tradeCount === 1) {
    utilizationCap = 1;
  }

  // Determine base quantity using selected model
  let qty;
  switch (methodName) {
    case 'fixed-rupee':
      qty = fixedRupeeRiskModel({ riskAmount: risk, slPoints });
      break;
    case 'fixed-percent':
      qty = fixedPercentRiskModel({ capital, riskPercent: risk, slPoints });
      break;
    case 'kelly':
      qty = kellyCriterionSize({ capital, winRate, winLossRatio, slPoints, fraction });
      break;
    case 'volatility-weighted':
      qty = volatilityWeightedSize({
        capital,
        baseRisk: risk,
        volatility,
        benchmarkVolatility,
        slPoints,
      });
      break;
    case 'equal-capital':
      qty = equalCapitalAllocation({ capital, numPositions, price });
      break;
    case 'equal-risk':
      qty = equalRiskAllocation({ capital, numPositions, slPoints });
      break;
    case 'confidence':
      const baseQty = fixedPercentRiskModel({ capital, riskPercent: risk, slPoints });
      qty = confidenceBasedSizing({ baseQty, confidence });
      break;
    case 'atr':
      qty = atrBasedSizing({ capital, atr: volatility, atrMult, riskPercent: risk });
      break;
    case 'dollar-volatility':
      qty = dollarVolatilitySizing({ capital, atr: volatility, price, riskPercent: risk });
      break;
    default: {
      let riskAmount = risk <= 1 ? capital * risk : risk;
      if (costBuffer > 1) {
        riskAmount /= costBuffer;
      }
      if (riskAmount <= 0) return 0;
      qty = riskAmount / slPoints;
    }
  }

  if (!qty || qty <= 0) return 0;

  if (volatility && volatilityGuard && volatility > volatilityGuard) {
    const factor = volatility / volatilityGuard;
    qty /= factor;
  }

  if (volatilityGuard && vix && volatility) {
    const combined = volatility * vix;
    if (combined > volatilityGuard) {
      const factor = combined / volatilityGuard;
      qty /= factor;
    }
  }

  if (priceMovement && volatility && Math.abs(priceMovement) > volatility) {
    qty *= 0.9;
  }

  if (marketDepth && marketDepth.buy && marketDepth.sell) {
    const ratio = marketDepth.buy / (marketDepth.sell || 1);
    if (ratio < 0.7) qty *= 0.9;
    else if (ratio > 1.5) qty *= 1.1;
  }

  qty = Math.floor(qty);

  if (roundToLot && lotSize > 1) {
    qty = Math.floor(qty / lotSize) * lotSize;
  }

  const marginPct =
    typeof marginPercent === 'number'
      ? marginPercent
      : leverage > 0
      ? 1 / leverage
      : DEFAULT_MARGIN_PERCENT;
  const effectiveMarginPerLot =
    (marginPerLot || (price ? price * lotSize * marginPct : 0)) *
    exchangeMarginMultiplier *
    marginBuffer;
  if (effectiveMarginPerLot > 0) {
    const maxLots = Math.floor((capital * utilizationCap) / effectiveMarginPerLot);
    qty = Math.min(qty, maxLots * lotSize);
  }

  if (typeof minQty === 'number' && qty < minQty) return 0;
  if (typeof minLotSize === 'number' && qty < minLotSize) return 0;
  if (typeof maxQty === 'number' && qty > maxQty) qty = maxQty;

  return qty > 0 ? qty : lotSize;
}

/**
 * Calculate trade parameters including stop loss, quantity and targets.
 * Handles dynamic and fallback stop losses, RR based target calculation
 * and drawdown based quantity adjustment.
 *
 * @param {Object} opts
 * @param {number} opts.entry       Trade entry price
 * @param {number} [opts.stopLoss]  Pattern provided stop loss
 * @param {'Long'|'Short'} opts.direction Trade direction
 * @param {number} opts.atr         Current ATR value
 * @param {number} opts.capital     Trading capital
 * @param {number} [opts.leverage]  Leverage multiplier
 * @param {number} [opts.marginPercent] Broker margin percentage
 * @param {number} [opts.drawdown]  Current drawdown percentage (0-1)
 * @param {number} [opts.slippage]  Expected slippage per unit
 * @param {number} [opts.spread]    Current bid/ask spread
 * @param {number} [opts.costBuffer] Buffer for taxes and slippage
 * @returns {Object} { stopLoss, qty, target1, target2 }
 */
export function calculateTradeParameters({
  entry,
  stopLoss,
  direction,
  atr,
  capital,
  leverage = 0,
  marginPercent,
  drawdown = 0,
  slippage = 0,
  spread = 0,
  costBuffer = 1,
}) {
  const dynamicSL = calculateDynamicStopLoss({ atr, entry, direction });

  let finalSL = dynamicSL;

  if (typeof stopLoss === 'number') {
    const patternSL = stopLoss;
    const distDyn = Math.abs(entry - dynamicSL);
    const distPat = Math.abs(entry - patternSL);
    finalSL =
      direction === 'Long'
        ? Math.max(finalSL, patternSL)
        : Math.min(finalSL, patternSL);
    if (distPat < distDyn) finalSL = patternSL;
  }

  if (
    (direction === 'Long' && finalSL >= entry) ||
    (direction === 'Short' && finalSL <= entry)
  ) {
    finalSL = dynamicSL;
  }

  finalSL = adjustStopLoss({
    price: entry,
    stopLoss: finalSL,
    direction,
    atr,
  });

  const baseRisk = Math.abs(entry - finalSL) + slippage + spread;
  const riskAmount = capital * 0.01;
  let qty = calculatePositionSize({
    capital,
    risk: riskAmount,
    slPoints: baseRisk,
    price: entry,
    volatility: atr,
    lotSize: 1,
    utilizationCap: 1,
    leverage,
    marginPercent,
    costBuffer,
  });

  qty = adjustRiskBasedOnDrawdown({ drawdown, lotSize: qty });

  const rrMultiplier = atr > 2 ? RISK_REWARD_RATIO + 0.5 : RISK_REWARD_RATIO;
  const target1 =
    entry + (direction === 'Long' ? 1 : -1) * (rrMultiplier * 0.5) * baseRisk;
  const target2 =
    entry + (direction === 'Long' ? 1 : -1) * rrMultiplier * baseRisk;

  return { stopLoss: finalSL, qty, target1, target2 };
}



