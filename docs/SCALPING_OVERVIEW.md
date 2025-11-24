# Scalping Architecture Overview

This repository now contains an opt-in **scalping mode** focused on 1-minute data and
fast trade lifecycles. The system is split into scanner-side components and an
execution service.

## Folder Layout (new files)

```
src/scalping/
  config/          // scalping-specific configuration loader
  data/            // data layer (tick -> 1m candles, rolling caches)
  strategies/      // ScalpEngine and indicator-driven logic
  indicators/      // light-weight indicator helpers (EMA, VWAP, ATR)
  services/        // outbound integrations (SignalPublisher -> execution svc)
  scannerRuntime.js// bootstrap helper to wire ticker -> engine
```

## Scanner responsibilities
- Subscribe to Zerodha ticker and feed ticks to `CandleAggregator`.
- Retain only the required rolling candle history in memory for fast indicators.
- Run `ScalpEngine` on each closed 1m candle.
- Emit normalized signals and push them to the execution service via
  `SignalPublisher` (HTTP POST `/api/signals`).

## Execution service (to be expanded next)
- Exposes REST `/api/signals` endpoint.
- Validates and stores signals.
- Feeds the `RiskEngine` and `ExecutionService` (simulation/live modes).
- Manages exits via `ExitManager` (SL/target/time/EOD exits).

## Configuration
- Set `MODE=SCALPING` (or `TRADING_MODE=SCALPING`) to activate scalping defaults.
- Environment variables:
  - `SCALPING_UNIVERSE` (comma separated), `SCALPING_MAX_POSITIONS`,
    `SCALPING_CANDLE_HISTORY`.
  - Risk defaults: `SCALPING_RISK_PER_TRADE`, `SCALPING_DAILY_LOSS`,
    `SCALPING_MAX_TRADES`.
  - `EXECUTION_SERVICE_URL` for posting signals.
- Simulation is detected via `MODE=SIMULATION` or `TRADING_MODE=SIMULATION`.

## Next steps
- Add signal intake route to the execution service with schema validation.
- Implement `RiskEngine`, `ExecutionService`, and `ExitManager` modules tailored to
  SCALPING mode.
- Add health checks and kill-switch handling shared between scanner & executor.
