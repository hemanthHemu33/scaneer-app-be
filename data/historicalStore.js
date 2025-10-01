import db from '../db.js';
import { logError } from '../logger.js';

const defaults = {
  maxBarsDaily: 300,
  maxBarsIntraday: 300,
  dailyStaleMs: 6 * 60 * 60 * 1000,
  intradayStaleMs: 5 * 60 * 1000,
  enableChangeStream: false,
  metrics: {},
};

function initHistoricalStore(options = {}) {
  const cfg = { ...defaults, ...options };
  const metrics = cfg.metrics || {};

  const dailyCache = new Map();
  const intradayCache = new Map();
  const dailyLocks = new Map();
  const intradayLocks = new Map();

  let changeStreams = [];

  const state = {
    dailyModel: null, // 'single' | 'token'
  };

  function metric(name, ...args) {
    try {
      const fn = metrics[name];
      if (typeof fn === 'function') fn(...args);
    } catch (err) {
      logError('historicalStore.metric', err);
    }
  }

  function key(token) {
    return String(token);
  }

  function isStale(entry, ttl) {
    return !entry || Date.now() - entry.lastLoadedAt > ttl;
  }

  function withLock(map, token, fn) {
    const k = key(token);
    const prev = map.get(k) || Promise.resolve();
    let release;
    const p = new Promise((res) => (release = res));
    map.set(k, prev.then(() => p));
    return prev
      .then(() => fn())
      .finally(() => {
        release();
        if (map.get(k) === p) map.delete(k);
      });
  }

  function dedupeAndSort(arr) {
    const map = new Map();
    for (const c of arr || []) {
      const t = +new Date(c.date ?? c.timestamp);
      if (!Number.isFinite(t)) continue;
      if (!map.has(t)) {
        const d = new Date(t);
        map.set(t, {
          ...c,
          date: d,
          timestamp: d,
        });
      }
    }
    return [...map.values()].sort((a, b) => +a.date - +b.date);
  }

  async function detectDailyModel() {
    if (state.dailyModel) return state.dailyModel;
    try {
      const doc = await db.collection('historical_data').findOne({});
      if (doc && (doc.token || doc.candles)) {
        state.dailyModel = 'token';
      } else {
        state.dailyModel = 'single';
      }
    } catch (err) {
      logError('historicalStore.detectDailyModel', err);
      state.dailyModel = 'single';
    }
    return state.dailyModel;
  }

  function sliceCandles(candles, { limit, from, to } = {}) {
    let arr = candles || [];
    if (from) {
      const f = +new Date(from);
      arr = arr.filter((c) => +new Date(c.date ?? c.timestamp) >= f);
    }
    if (to) {
      const t = +new Date(to);
      arr = arr.filter((c) => +new Date(c.date ?? c.timestamp) <= t);
    }
    if (limit) arr = arr.slice(-limit);
    return arr;
  }

  async function loadDaily(token) {
    const k = key(token);
    const max = cfg.maxBarsDaily;
    const start = Date.now();
    try {
      const col = db.collection('historical_data');
      const limit = max;
      // try single doc model first
      const projection = { [k]: { $slice: -limit }, _id: 0 };
      let doc = await col.findOne({}, { projection });
      let arr = doc?.[k];
      if (!arr) {
        // per-token model
        doc = await col.findOne(
          { token: Number(k) },
          { projection: { candles: { $slice: -limit }, data: { $slice: -limit }, _id: 0 } }
        );
        arr = doc?.candles || doc?.data;
        if (arr) state.dailyModel = 'token';
      } else {
        state.dailyModel = 'single';
      }
      const candles = dedupeAndSort(arr || []).slice(-max);
      dailyCache.set(k, { candles, lastLoadedAt: Date.now() });
      metric('onLoadMs', Date.now() - start, 'daily');
      return candles;
    } catch (err) {
      logError('historicalStore.loadDaily', err);
      metric('onError', err, token, 'daily');
      dailyCache.set(k, { candles: [], lastLoadedAt: Date.now() });
      return [];
    }
  }

  async function getDailyCandles(token, opts = {}) {
    const k = key(token);
    return withLock(dailyLocks, k, async () => {
      let entry = dailyCache.get(k);
      if (entry && !isStale(entry, cfg.dailyStaleMs)) {
        metric('onHit', 'daily');
        return sliceCandles(entry.candles, opts);
      }
      metric('onMiss', 'daily');
      const candles = await loadDaily(k);
      return sliceCandles(candles, opts);
    });
  }

  async function appendDailyCandles(token, candles = []) {
    const k = key(token);
    return withLock(dailyLocks, k, async () => {
      const entry = dailyCache.get(k) || { candles: [], lastLoadedAt: 0 };
      const normalized = candles
        .map((c) => {
          const raw = c.date ?? c.timestamp;
          const date = c.date instanceof Date ? c.date : new Date(raw);
          const timestamp =
            c.timestamp instanceof Date ? c.timestamp : new Date(raw);
          return {
            ...c,
            date,
            timestamp,
          };
        })
        .filter((c) => Number.isFinite(+c.date));
      const merged = dedupeAndSort([...entry.candles, ...normalized]);
      const bounded = merged.slice(-cfg.maxBarsDaily);
      const start = Date.now();
      try {
        const model = await detectDailyModel();
        const col = db.collection('historical_data');
        if (model === 'single') {
          await col.updateOne(
            {},
            { $push: { [k]: { $each: normalized, $slice: -cfg.maxBarsDaily } } },
            { upsert: true }
          );
        } else {
          await col.updateOne(
            { token: Number(k) },
            { $push: { candles: { $each: normalized, $slice: -cfg.maxBarsDaily } } },
            { upsert: true }
          );
        }
        metric('onWriteMs', Date.now() - start, 'daily');
      } catch (err) {
        logError('historicalStore.appendDailyCandles', err);
        metric('onError', err, token, 'daily');
      }
      dailyCache.set(k, { candles: bounded, lastLoadedAt: Date.now() });
      return bounded;
    });
  }

  async function loadIntraday(token) {
    const k = key(token);
    const max = cfg.maxBarsIntraday;
    const start = Date.now();
    try {
      const doc = await db
        .collection('historical_session_data')
        .findOne(
          { token: Number(k) },
          { projection: { candles: { $slice: -max }, data: { $slice: -max }, _id: 0 } }
        );
      const arr = doc?.candles || doc?.data || [];
      const candles = dedupeAndSort(arr).slice(-max);
      intradayCache.set(k, { candles, lastLoadedAt: Date.now() });
      metric('onLoadMs', Date.now() - start, 'intraday');
      return candles;
    } catch (err) {
      logError('historicalStore.loadIntraday', err);
      metric('onError', err, token, 'intraday');
      intradayCache.set(k, { candles: [], lastLoadedAt: Date.now() });
      return [];
    }
  }

  async function getIntradayCandles(token, opts = {}) {
    const k = key(token);
    return withLock(intradayLocks, k, async () => {
      let entry = intradayCache.get(k);
      if (entry && !isStale(entry, cfg.intradayStaleMs)) {
        metric('onHit', 'intraday');
        return sliceCandles(entry.candles, opts);
      }
      metric('onMiss', 'intraday');
      const candles = await loadIntraday(k);
      return sliceCandles(candles, opts);
    });
  }

  async function appendIntradayCandles(token, candles = []) {
    const k = key(token);
    return withLock(intradayLocks, k, async () => {
      const entry = intradayCache.get(k) || { candles: [], lastLoadedAt: 0 };
      const normalized = candles
        .map((c) => {
          const raw = c.date ?? c.timestamp;
          const date = c.date instanceof Date ? c.date : new Date(raw);
          const timestamp =
            c.timestamp instanceof Date ? c.timestamp : new Date(raw);
          return {
            ...c,
            date,
            timestamp,
          };
        })
        .filter((c) => Number.isFinite(+c.date));
      const merged = dedupeAndSort([...entry.candles, ...normalized]);
      const bounded = merged.slice(-cfg.maxBarsIntraday);
      const start = Date.now();
      try {
        await db.collection('historical_session_data').updateOne(
          { token: Number(k) },
          { $push: { candles: { $each: normalized, $slice: -cfg.maxBarsIntraday } } },
          { upsert: true }
        );
        metric('onWriteMs', Date.now() - start, 'intraday');
      } catch (err) {
        logError('historicalStore.appendIntradayCandles', err);
        metric('onError', err, token, 'intraday');
      }
      intradayCache.set(k, { candles: bounded, lastLoadedAt: Date.now() });
      return bounded;
    });
  }

  async function warmup(tokens = [], { daily = true, intraday = true } = {}) {
    const arr = Array.from(tokens || []);
    const tasks = [];
    for (const t of arr) {
      if (daily) tasks.push(getDailyCandles(t));
      if (intraday) tasks.push(getIntradayCandles(t));
    }
    await Promise.all(tasks);
  }

  function invalidate(token, { scope = 'all' } = {}) {
    const k = key(token);
    if (scope === 'all' || scope === 'daily') dailyCache.delete(k);
    if (scope === 'all' || scope === 'intraday') intradayCache.delete(k);
  }

  function shutdown() {
    for (const cs of changeStreams) {
      try {
        cs.close();
      } catch (_) {}
    }
    changeStreams = [];
    dailyCache.clear();
    intradayCache.clear();
  }

  return {
    getDailyCandles,
    getIntradayCandles,
    appendDailyCandles,
    appendIntradayCandles,
    warmup,
    invalidate,
    shutdown,
    _cache: { dailyCache, intradayCache },
  };
}

export { initHistoricalStore };
export default initHistoricalStore;

