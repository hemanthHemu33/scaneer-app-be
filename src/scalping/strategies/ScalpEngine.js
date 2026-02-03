import EventEmitter from "events";
import { ema, vwapFromCandles, slope, averageTrueRange } from "../indicators/index.js";
import { buildSignal } from "../utils/signalSchema.js";
import { logWarn } from "../../logger.js";

/**
 * ScalpEngine listens to 1m candles and emits normalized scalping signals.
 */
export class ScalpEngine extends EventEmitter {
  constructor({ aggregator, config, publisher } = {}) {
    super();
    this.aggregator = aggregator;
    this.config = config;
    this.publisher = publisher;
  }

  start() {
    if (!this.aggregator) {
      throw new Error("ScalpEngine requires a CandleAggregator instance");
    }
    this.aggregator.on("candle", (symbol, candle) => {
      try {
        const signal = this.#evaluateCandle(symbol, candle);
        if (signal) {
          this.emit("signal", signal);
          if (this.publisher) {
            this.publisher.publish(signal);
          }
        }
      } catch (err) {
        logWarn("ScalpEngine", err.message, { symbol });
      }
    });
  }

  #evaluateCandle(symbol, candle) {
    const candles = this.aggregator.getRecentCandles(symbol, 30);
    if (candles.length < 10) return null;

    const closes = candles.map((c) => c.close);
    const ema5 = ema(closes, 5);
    const ema9 = ema(closes, 9);
    const vwap = vwapFromCandles(candles.slice(-20));
    const trendSlope = slope(closes.slice(-4));
    const atr = averageTrueRange(candles, 14) || 0;
    const latest = candles[candles.length - 1];

    const pullbackOk = Math.abs(latest.close - (vwap ?? latest.close)) <= (atr || 1) * 0.3;

    const uptrend = ema5 && ema9 && ema5 > ema9 && trendSlope > 0;
    const downtrend = ema5 && ema9 && ema5 < ema9 && trendSlope < 0;

    if (!vwap) return null;

    if (uptrend && latest.close > vwap && pullbackOk) {
      return this.#buildScalpSignal({
        symbol,
        side: "BUY",
        reference: latest,
        atr,
      });
    }

    if (downtrend && latest.close < vwap && pullbackOk) {
      return this.#buildScalpSignal({
        symbol,
        side: "SELL",
        reference: latest,
        atr,
      });
    }

    return null;
  }

  #buildScalpSignal({ symbol, side, reference, atr }) {
    const buffer = atr ? Math.max(atr * 0.2, reference.close * 0.0015) : reference.close * 0.0015;
    const stopLoss = side === "BUY" ? reference.low - buffer : reference.high + buffer;
    const target = side === "BUY" ? reference.close + buffer * 1.8 : reference.close - buffer * 1.8;

    const confidence = Math.min(1, (atr ? buffer / atr : 0.2) + 0.3);

    return buildSignal({
      symbol,
      side,
      entryType: "MARKET",
      entryPriceHint: reference.close,
      stopLoss,
      target,
      quantity: 0, // sized later by RiskEngine
      strategyId: "SCALP_V1",
      confidence,
      timeValidTill: Date.now() + 60_000 * 3,
    });
  }
}
