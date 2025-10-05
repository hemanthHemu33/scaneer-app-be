import {
  toISTISOString,
  toISTDate,
  convertTickTimestampsToIST,
} from './util.js';

export function buildSignal(context = {}, pattern = {}, tradeParams = {}, confidence = '') {
  const {
    symbol,
    instrumentToken,
    ma20Val,
    ma50Val,
    ema9,
    ema21,
    ema50,
    ema200,
    rsi,
    supertrend,
    atrValue,
    slippage = 0,
    spread = 0,
    liquidity,
    liveTick,
    depth,
    rrMultiplier,
    rvol,
    vwap,
    expiryMinutes,
    riskReward,
    trendStrength,
    volatilityClass,
    emaSlope,
    isUptrend,
    isDowntrend,
    strategyName,
    strategyConfidence,
    support,
    resistance,
    finalScore,
    expiresAt,
    riskAmount,
    accountBalance,
    baseRisk,
    rawStopDistance,
    effectiveStopDistance,
    costBufferApplied,
    sizingDebug = {},
  } = context;

  const { entry, stopLoss, target1, target2, qty } = tradeParams;

  const sanitizeNumber = (value, precision) => {
    if (!Number.isFinite(value)) return null;
    return typeof precision === 'number' ? parseFloat(value.toFixed(precision)) : Number(value);
  };

  const sanitizedRawStop = sanitizeNumber(
    rawStopDistance !== undefined ? rawStopDistance : baseRisk,
    4
  );
  const sanitizedEffectiveStop = sanitizeNumber(
    effectiveStopDistance !== undefined
      ? effectiveStopDistance
      : sizingDebug.effectiveDistance,
    4
  );
  const sanitizedCostBuffer = sanitizeNumber(
    costBufferApplied !== undefined ? costBufferApplied : sizingDebug.costBuffer,
    4
  );

  let sizingDiagnostics;
  if (sizingDebug && typeof sizingDebug === 'object' && Object.keys(sizingDebug).length) {
    sizingDiagnostics = {
      rawDistance: sanitizeNumber(sizingDebug.rawDistance, 4),
      effectiveDistance: sanitizeNumber(sizingDebug.effectiveDistance, 4),
      requestedQty: sanitizeNumber(sizingDebug.requestedQty, 4),
      modelAdjustedQty: sanitizeNumber(sizingDebug.modelAdjustedQty, 4),
      roundedQty: sanitizeNumber(sizingDebug.roundedQty),
      roundToLot: sizingDebug.roundToLot
        ? {
            before: sanitizeNumber(sizingDebug.roundToLot.before),
            after: sanitizeNumber(sizingDebug.roundToLot.after),
            lotSize: sanitizeNumber(sizingDebug.roundToLot.lotSize),
          }
        : null,
      marginCap: sizingDebug.marginCap
        ? {
            maxLots: sanitizeNumber(sizingDebug.marginCap.maxLots),
            capQty: sanitizeNumber(sizingDebug.marginCap.capQty),
          }
        : null,
      marginCapped: Boolean(sizingDebug.marginCapped),
      qtyAfterMargin: sanitizeNumber(sizingDebug.qtyAfterMargin),
      finalQty: sanitizeNumber(sizingDebug.finalQty),
      signalQty: sanitizeNumber(sizingDebug.signalQty),
    };
    const hasMeaningfulSizing = Object.entries(sizingDiagnostics).some(([key, value]) => {
      if (value === null || value === undefined) return false;
      if (typeof value === 'object') {
        return value !== null && Object.values(value).some((nested) => nested !== null && nested !== undefined);
      }
      if (key === 'marginCapped') return value === true;
      return true;
    });
    if (!hasMeaningfulSizing) sizingDiagnostics = undefined;
  }

  const generatedAt = toISTISOString();
  const tickIST = convertTickTimestampsToIST(liveTick);
  const stockName = symbol.split(':')[1] || symbol;
  const expiryDate = expiresAt ? toISTDate(expiresAt) : undefined;
  const expiryMinutesNum =
    typeof expiryMinutes === 'number'
      ? expiryMinutes
      : expiresAt
      ? Math.round(
          (new Date(expiresAt).getTime() - new Date(generatedAt).getTime()) /
            60000
        )
      : undefined;

  const signal = {
    stock: symbol,
    instrument_token: instrumentToken,
    pattern: pattern.type,
    strength: pattern.strength,
    direction: pattern.direction,
    entry: entry !== undefined ? parseFloat(entry.toFixed(2)) : null,
    stopLoss: stopLoss !== undefined ? parseFloat(stopLoss.toFixed(2)) : null,
    target1: target1 !== undefined ? parseFloat(target1.toFixed(2)) : null,
    target2: target2 !== undefined ? parseFloat(target2.toFixed(2)) : null,
    qty,
    riskPerUnit: baseRisk !== undefined ? parseFloat(baseRisk.toFixed(2)) : null,
    rawStopDistance: sanitizedRawStop,
    effectiveStopDistance: sanitizedEffectiveStop,
    costBuffer: sanitizedCostBuffer,
    riskAmount: riskAmount !== undefined ? parseFloat(riskAmount.toFixed(2)) : null,
    accountBalance: accountBalance !== undefined ? parseFloat(accountBalance.toFixed(2)) : null,
    rsi: rsi !== undefined ? parseFloat(rsi.toFixed(2)) : null,
    liveRSI: rsi !== undefined ? parseFloat(rsi.toFixed(2)) : null,
    ma20: ma20Val !== null ? parseFloat(ma20Val.toFixed(2)) : null,
    ma50: ma50Val !== null ? parseFloat(ma50Val.toFixed(2)) : null,
    support: support !== null ? parseFloat(support.toFixed(2)) : null,
    resistance: resistance !== null ? parseFloat(resistance.toFixed(2)) : null,
    ema9: ema9 !== undefined ? parseFloat(ema9.toFixed(2)) : null,
    ema21: ema21 !== undefined ? parseFloat(ema21.toFixed(2)) : null,
    ema50: ema50 !== undefined ? parseFloat(ema50.toFixed(2)) : null,
    ema200: ema200 !== undefined ? parseFloat(ema200.toFixed(2)) : null,
    supertrend,
    liveVWAP: vwap !== undefined && vwap !== null ? parseFloat(vwap.toFixed(2)) : null,
    priceDeviation: vwap !== undefined && vwap !== null ? parseFloat((entry - vwap).toFixed(2)) : null,
    atr: atrValue,
    trendStrength,
    emaSlope,
    volatilityClass,
    riskReward,
    slippage: parseFloat(slippage.toFixed(2)),
    spread: parseFloat(spread.toFixed(2)),
    liquidity,
    confidence,
    confidenceScore: finalScore,
    liveTickData: tickIST,
    depth,
    expiresAt: expiresAt ? toISTISOString(expiresAt) : undefined,
    expiryDate,
    expiryMinutes: expiryMinutesNum,
    stockName,
    strategy: strategyName,
    generatedAt,
    source: 'analyzeCandles',
    sizing: sizingDiagnostics,
  };

  const advancedSignal = {
    signalId: `${symbol}-1m-${strategyName.replace(/\s+/g, '-')}-${toISTISOString().replace(/[:.-]/g, '')}`,
    symbol,
    timeframe: '1m',
    strategy: strategyName,
    side: pattern.direction === 'Long' ? 'buy' : 'sell',
    entry: signal.entry,
    stopLoss: signal.stopLoss,
    targets: [signal.target1, signal.target2],
    quantity: qty,
    risk: {
      rrRatio: parseFloat(riskReward.toFixed(2)),
      slDistance: parseFloat(Math.abs(signal.entry - signal.stopLoss).toFixed(2)),
      capitalRequired: parseFloat((signal.entry * qty).toFixed(2)),
    },
    filters: {
      rvol: parseFloat(rvol.toFixed(2)),
      marketTrend: isUptrend ? 'bullish' : isDowntrend ? 'bearish' : 'sideways',
    },
    context: { volatility: atrValue.toFixed(2), trendStrength, volatilityClass, emaSlope },
    levels: { support, resistance },
    confidenceScore: strategyConfidence,
    executionWindow: {
      validFrom: generatedAt,
      validUntil: expiresAt ? toISTISOString(expiresAt) : undefined,
    },
    executionHint: {
      type: 'limitOrMarket',
      slippageTolerance: 0.05,
      broker: 'zerodha',
      strategyRef: `id:${strategyName.toLowerCase().replace(/\s+/g, '-')}`,
    },
    status: 'active',
    expiresAt: expiresAt ? toISTISOString(expiresAt) : undefined,
    autoCancelOn: [],
  };

  return { signal, advancedSignal };
}
