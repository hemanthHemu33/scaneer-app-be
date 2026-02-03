import EventEmitter from "events";

/**
 * CandleAggregator converts ticks into 1m candles and retains a bounded
 * in-memory history per symbol. It emits `candle` events when a candle closes.
 */
export class CandleAggregator extends EventEmitter {
  constructor({ historySize = 120, universe = [] } = {}) {
    super();
    this.historySize = historySize;
    this.universe = new Set(universe);
    this.state = new Map();
  }

  /**
   * Ingest a tick { symbol, lastPrice, volume, timestamp }
   */
  ingestTick(tick) {
    if (!tick?.symbol || typeof tick.lastPrice !== "number") return;
    if (this.universe.size && !this.universe.has(tick.symbol)) return;

    const ts = tick.timestamp ? new Date(tick.timestamp).getTime() : Date.now();
    const minuteStart = ts - (ts % 60000);
    const record = this.state.get(tick.symbol) || {
      current: null,
      history: [],
      lastTickAt: null,
    };

    if (!record.current || record.current.start !== minuteStart) {
      if (record.current) {
        this.#finalizeCandle(tick.symbol, record.current);
        this.#pushHistory(record, record.current);
      }
      record.current = {
        start: minuteStart,
        open: tick.lastPrice,
        high: tick.lastPrice,
        low: tick.lastPrice,
        close: tick.lastPrice,
        volume: tick.volume || 0,
        vwapNumerator: (tick.volume || 0) * tick.lastPrice,
        trades: 1,
      };
    } else {
      const c = record.current;
      c.high = Math.max(c.high, tick.lastPrice);
      c.low = Math.min(c.low, tick.lastPrice);
      c.close = tick.lastPrice;
      c.volume += tick.volume || 0;
      c.vwapNumerator += (tick.volume || 0) * tick.lastPrice;
      c.trades += 1;
    }

    record.lastTickAt = ts;
    this.state.set(tick.symbol, record);
  }

  /**
   * Accept a ready-made candle (e.g., from REST/Historical) and store/emit it.
   */
  ingestCandle(symbol, candle) {
    if (!symbol || !candle) return;
    const record = this.state.get(symbol) || { history: [], lastTickAt: null };
    const normalized = this.#normalizeCandle(candle);
    this.#pushHistory(record, normalized);
    this.state.set(symbol, record);
    this.emit("candle", symbol, normalized);
  }

  #finalizeCandle(symbol, candle) {
    const normalized = this.#normalizeCandle(candle);
    this.emit("candle", symbol, normalized);
  }

  #normalizeCandle(candle) {
    const volume = candle.volume ?? 0;
    const vwapNumerator =
      candle.vwapNumerator ??
      (typeof candle.vwap === "number" && volume > 0 ? candle.vwap * volume : 0);
    const vwap = volume > 0 ? vwapNumerator / volume : candle.close;
    return {
      start: candle.start,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume,
      trades: candle.trades ?? 0,
      vwap,
    };
  }

  #pushHistory(record, candle) {
    record.history.push(candle);
    if (record.history.length > this.historySize) {
      record.history.shift();
    }
  }

  /**
   * Retrieve last N candles (most recent last).
   */
  getRecentCandles(symbol, lookback = 5) {
    const record = this.state.get(symbol);
    if (!record?.history?.length) return [];
    return record.history.slice(-lookback);
  }

  getLastTickAt(symbol) {
    const record = this.state.get(symbol);
    return record?.lastTickAt || null;
  }
}
