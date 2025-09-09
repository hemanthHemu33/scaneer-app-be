# Scanner App Backend (Indian Equities)

A real‑time scanner and trade‑decision engine for the Indian stock market. It ingests live ticks & intraday candles (Zerodha Kite), detects multi‑indicator setups, validates risk, sizes positions, manages signal lifecycle, and exposes REST + WebSocket APIs for frontend clients.

> Production‑ready Node.js service with MongoDB, Express, Socket.IO, and a modular strategy/risk stack.

---

## ✨ Features

* **Live market data** via Zerodha Kite (ticks + historical candles)
* **60+ pattern & indicator detectors** (EMA/SMA/RSI/ATR/Supertrend/MACD/VWAP/etc.)
* **Strategy engine** combining patterns, trend, volume, VWAP reactions, breakouts, gap plays, and more
* **Risk validator** with regime awareness: RR thresholds by strategy, ATR‑based SL, timing/news filters, index/sector alignment, spreads/volume checks
* **Position sizing** using capital, SL distance, margin/leverage, volatility guards
* **Signal lifecycle** (active → triggered/expired/cancelled) with TTL and real‑time updates
* **Portfolio context** to avoid conflicts and cap exposure
* **Audit trail** with optional encrypted logs + Telegram alerts
* **REST + WebSocket** interfaces for administration and live dashboards

---

## 🏗️ Architecture

```
Kite (ticks/candles) → Feature Engine → Strategy Engine → Scanner
                                       ↓                  ↓
                                  Risk Layer        Signal Manager
                                       ↓                  ↓
                                 Position Sizing    Trade Lifecycle
                                       ↓                  ↓
                                     Broker API      Observability
```

**Core modules**: `featureEngine`, `strategies`, `strategyEngine`, `scanner`, `riskValidator`/`riskEngine`/`dynamicRiskModel`, `positionSizing`, `portfolioContext`, `signalManager`, `tradeLifecycle`/`orderExecution`/`exitManager`, `auditLogger`/`auditEngine`/`tradeLogger`.

---

## 📦 Tech Stack

* Node.js ≥ 18, Express 5, Socket.IO
* MongoDB (Atlas‑compatible)
* Zerodha Kite Connect SDK (market data + orders)
* node‑cron, dayjs (timezone aware), dotenv, cors
* Telegram bot for notifications (optional)

---

## 🚀 Getting Started

### 1) Clone & Install

```bash
npm install
```

### 2) Configure Environment

Create `.env` in the project root:

```dotenv
# MongoDB
DB_USER_NAME=...
DB_PASSWORD=...
DB_NAME=...

# Zerodha Kite
KITE_API_KEY=...
KITE_API_SECRET=...

# Telegram (optional)
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...

# Optional
OPENAI_API_KEY=...
LOG_ENCRYPTION_KEY= # 32‑byte hex for audit encryption
MAX_OPEN_TRADES=5
NODE_ENV=development
```

### 3) Run

```bash
npm start      # HTTP + Socket.IO on :3000
```

The server preloads data around **09:00 IST** and starts the live feed during market hours.

### 4) Dev & Tests

```bash
npm run dev    # with nodemon
npm test       # Node test runner (module mocks enabled)
```

---

## 🔌 API (REST)

Base URL: `http://localhost:3000`

### POST `/addStockSymbol`

Add a symbol to the tracked universe.

```json
{ "symbol": "TCS" }
```

→ `{"status":"success","symbols":["NSE:TCS", ...]}`

### GET `/stockSymbols`

List tracked symbols.

### DELETE `/stockSymbols/:symbol`

Remove a symbol (also purges its caches).

### DELETE `/reset`

Dangerous: clears most runtime collections.

### GET `/signals`

Latest generated signals (desc by `generatedAt`).

### GET `/signal-history`

Returns in‑memory signal history snapshot.

### POST `/set-interval`

Control tick processing cadence (ms).

```json
{ "interval": 500 }
```

### POST `/fetch-intraday-data`

Trigger historical backfill.

```json
{ "interval": "minute", "days": 3 }
```

### GET `/kite-redirect`

OAuth redirect capture for Kite `request_token` → creates/refreshes the trading session.

> **Auth/CORS:** CORS enabled; endpoints are unauthenticated by default—front your service with an API gateway or add auth middleware before production.

---

## 📡 WebSocket (Socket.IO)

* On connect: `serverMessage: "Connected to backend."`
* If market open: live tick streams (event names as defined in `kite.js`).

---

## 🧠 Signals & Lifecycle

A **signal** includes symbol, direction, entry, SL, targets, RR, ATR, confidence, pattern, expiry, and execution hints.

**Flow:** `active` → `triggered | expired | cancelled`

* **Expiry:** background worker scans and invalidates stale signals (TTL)
* **Triggered:** order flow managed via `tradeLifecycle` + `orderExecution`

---

## 🛡️ Risk Model (Pre‑Execution)

* **RR thresholds** (by strategy): Trend ≥2.0; Breakout ≥1.8; Mean‑reversion ≥1.5; Scalping ≥1.2 (if win‑rate > 65%); News/Event ≥2+
* **ATR‑based SL** & regime controls; no SL widening in trends
* **Timing & news filters**; index/sector alignment; volume/spread & stale‑signal guards
* **Portfolio context**: exposures (e.g., >75% cap), re‑entry avoidance, sector caps

---

## 📏 Position Sizing

`quantity = f(capital, slPoints, price, margin/leverage, lotSize, ATR)`
Defaults: **RR = 1.5**, fallback `marginPercent = 0.2`, lot rounding supported.

---

## 🗂️ Project Structure (abridged)

```
index.js
scanner.js
strategyEngine.js
strategies.js
featureEngine.js
riskValidator.js
riskEngine.js
dynamicRiskModel.js
positionSizing.js
portfolioContext.js
signalBuilder.js
signalManager.js
tradeLifecycle.js
orderExecution.js
exitManager.js
confidence.js
signalRanker.js
feedbackEngine.js
kite.js
openAI.js
telegram.js
logger.js
auditLogger.js
auditEngine.js
tradeLogger.js
routes/
tests/
```

---

## 🔭 Observability & Audit

* **Audit logs** (optional AES‑256 encryption) + **Telegram** critical alerts
* **Order reconciliation** at close (compare executed signals vs trade logs)
* **Error handling** with fallback alerts

---

## 🗓️ Schedules & Market Hours

* Preload at **09:00 IST** (Mon–Fri)
* Additional preload window \~**09:30–09:40 IST** on server start
* Live feed only when `isMarketOpen()` returns true

---

## 🧰 Troubleshooting

* **Mongo connect fails** → validate `DB_*` and network; Atlas IP allowlist
* **No ticks** → complete Kite OAuth (`/kite-redirect`); check market hours
* **Stale signals** → adjust `/set-interval`, verify cron preload, confirm market open
* **No Telegram alerts** → verify `TELEGRAM_*`; ensure bot can message the chat

---

## 🏁 Runbook (Live Signals)

1. **Insert Kite session token**  
   Ensure a document `{ type: "kite_session", access_token: "<token>" }` exists in the `tokens` collection.

2. **Prepare universe (optional)**  
   The server seeds a default universe if `stock_symbols.symbols` is empty. POST `/addStockSymbol` to add more.

3. **Start server**  
   `npm start` before 09:15 IST. Startup log should include `♻️ Loaded access token from DB`.

4. **During market hours**
   When `isMarketOpen()` is true the log shows `🕒 Market open; starting live feed…` followed by `📈 Ticker connected` and `🔔 Subscribed N symbols`. Signals will stream through Socket.IO and persist in MongoDB.

5. **After hours / weekends**  
   The backend skips live feed and waits for next open.

## ✅ Acceptance Tests

1. **Session load** – With a valid token doc, startup logs `♻️ Loaded access token from DB`.
2. **Universe seed** – Empty `stock_symbols` results in `🌱 Seeded stock_symbols with defaults: [...]`.
3. **Live feed starts** – During market hours logs `🕒 Market open; starting live feed…`, `📈 Ticker connected`, and `🔔 Subscribed N symbols`.
4. **Signals flow** – With session and universe during market hours, new documents appear in `signals` collection and are emitted via WebSocket.
5. **Guard conditions** – Without a session or outside market hours logs `⚠️ No Kite session; live feed will not start.` or `⛔ Market closed: not starting live feed.`

## 🗺️ Roadmap

* Regime‑sensitive **Smart Strategy Selector** (VIX/ATR/breadth) gating
* Expanded broker adapters + robust OCO/bracket syncing
* OpenAPI (Swagger) spec & typed SDK
* Enhanced backtests with audit traceability

---

## 🤝 Contributing

PRs and issues welcome. Please include tests for new modules and keep functions pure where possible.

---

## 📄 License

Specify a license (e.g., MIT) and include a `LICENSE` file.
