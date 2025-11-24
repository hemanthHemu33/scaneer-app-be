import EventEmitter from "events";
import { CandleAggregator } from "./data/CandleAggregator.js";
import { ScalpEngine } from "./strategies/ScalpEngine.js";
import { SignalPublisher } from "./services/SignalPublisher.js";
import { loadScalpingConfig, SCALPING_MODE } from "./config/scalpingConfig.js";

/**
 * Bootstraps the scalping scanner side and wires ticker -> aggregator -> engine.
 */
export function initScalpingScanner({ ticker, publisher, config: cfgOverride } = {}) {
  const config = cfgOverride || loadScalpingConfig();
  const aggregator = new CandleAggregator({
    historySize: config.candleHistorySize,
    universe: config.universe,
  });

  const emitter = new EventEmitter();
  const finalPublisher =
    publisher || new SignalPublisher({ endpoint: config.executionServiceUrl });
  const scalpEngine = new ScalpEngine({ aggregator, config, publisher: finalPublisher });

  scalpEngine.on("signal", (signal) => emitter.emit("signal", signal));
  scalpEngine.start();

  if (ticker?.on) {
    ticker.on("tick", (tick) => aggregator.ingestTick(tick));
  }

  return {
    config,
    aggregator,
    scalpEngine,
    publisher: finalPublisher,
    emitter,
    isScalpingMode: config.mode === SCALPING_MODE,
  };
}
