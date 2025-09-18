# Observability and Metrics

The live worker periodically prints a compact metrics snapshot every minute. A typical log line looks like:

```
[metrics] {"ts":"2024-09-20T10:05:00.000Z","ticks":1240,"candles1mFormed":28,"evalSymbols":42,"candidates":3,"emitted":1,"rejectedBy":{"portfolioRules":2}}
```

Key counters:

- **ticks** – number of raw ticks ingested from the Kite websocket during the interval.
- **candles1mFormed** – count of one-minute candles closed by the aligner.
- **evalSymbols** – symbols evaluated by strategy logic (both realtime and aligned flows).
- **candidates** – signals considered before portfolio filters.
- **emitted** – signals persisted and announced to sinks (Telegram, sockets, etc.).
- **rejectedBy** – per-rule rejection counters. Each key maps to the filter/reason code that blocked a candidate.

Use the `rejectedBy` object to understand which guardrail is suppressing signals. A healthy run should show non-zero `candidates`. If `emitted` remains zero, check the dominant entry in `rejectedBy` for the blocking rule (for example `portfolioRules`, `exposure`, `vwapGuard`).

The logger also aggregates noisy warnings. Instead of repeating the same line for every unmapped token, the runtime emits summaries such as:

```
[WARN:UNMAPPED_TOKEN] total=37 unique=5 top=6469121:12,502:9
```

This means 37 unmapped ticks were observed across 5 tokens during the last aggregation window. Investigate the top offenders and ensure the instrument map contains the correct token.

For manual backfills you can run `node backfillToday.js` to rebuild aligned candles and session data for the current trading day.
