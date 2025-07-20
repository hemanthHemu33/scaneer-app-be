// positionSizing.js

import { calculateDynamicStopLoss, adjustRiskBasedOnDrawdown } from './dynamicRiskModel.js';
import { adjustStopLoss } from './riskValidator.js';
import { DEFAULT_MARGIN_PERCENT } from './util.js';

// Default risk to reward ratio used for target calculations
export const RISK_REWARD_RATIO = 1.5;

let tradeCount = 0;

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
 * @param {number} [opts.marginPerLot]     Margin required per lot. Defaults to Zerodha intraday policy if price is supplied.
 * @param {number} [opts.marginPercent]    Broker margin percentage (if not using leverage).
 * @param {number} [opts.leverage]         Leverage multiplier available from broker.
 * @param {number} [opts.volatilityGuard]  ATR/VIX threshold beyond which position size is scaled down.
 * @param {Object} [opts.marketDepth]      Current market depth { buy, sell }.
 * @param {number} [opts.priceMovement]    Recent price movement for dynamic scaling.
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
  marginPerLot,
  marginPercent,
  leverage = 0,
  volatilityGuard,
  marketDepth,
  priceMovement,
  minQty,
  maxQty,
}) {
  if (!capital || !slPoints || slPoints <= 0) return 0;

  tradeCount += 1;
  if (tradeCount === 1) {
    utilizationCap = 1;
  }

  // Determine risk amount
  const riskAmount = risk <= 1 ? capital * risk : risk;
  if (riskAmount <= 0) return 0;

  let qty = riskAmount / slPoints;

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

  if (lotSize > 1) qty = Math.floor(qty / lotSize) * lotSize;

  const marginPct =
    typeof marginPercent === 'number'
      ? marginPercent
      : leverage > 0
      ? 1 / leverage
      : DEFAULT_MARGIN_PERCENT;
  const effectiveMarginPerLot =
    marginPerLot || (price ? price * lotSize * marginPct : 0);
  if (effectiveMarginPerLot > 0) {
    const maxLots = Math.floor((capital * utilizationCap) / effectiveMarginPerLot);
    qty = Math.min(qty, maxLots * lotSize);
  }

  if (typeof minQty === 'number' && qty < minQty) return 0;
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

  const baseRisk = Math.abs(entry - finalSL);
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
  });

  qty = adjustRiskBasedOnDrawdown({ drawdown, lotSize: qty });

  const rrMultiplier = atr > 2 ? RISK_REWARD_RATIO + 0.5 : RISK_REWARD_RATIO;
  const target1 =
    entry + (direction === 'Long' ? 1 : -1) * (rrMultiplier * 0.5) * baseRisk;
  const target2 =
    entry + (direction === 'Long' ? 1 : -1) * rrMultiplier * baseRisk;

  return { stopLoss: finalSL, qty, target1, target2 };
}



