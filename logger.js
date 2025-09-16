import { sendNotification } from "./telegram.js";
import { canonToken } from "./canon.js";

const TOKEN_WARN_TTL_MS = 10 * 60 * 1000;
const ERROR_DEDUPE_TTL_MS = 60 * 1000;
const WARN_AGGREGATE_INTERVAL_MS = 60 * 1000;
const warnDedupe = new Map();
const warnAggregates = new Map();
const errorDedupe = new Map();
let aggregateTimer = null;

function ensureAggregateTimer() {
  if (aggregateTimer) return;
  aggregateTimer = setInterval(() => {
    flushWarnAggregates();
  }, WARN_AGGREGATE_INTERVAL_MS);
  if (aggregateTimer.unref) aggregateTimer.unref();
}

function flushWarnAggregates() {
  if (!warnAggregates.size) return;
  for (const [code, entry] of warnAggregates.entries()) {
    const { total, tokens } = entry;
    const sortedTokens = [...tokens.entries()].sort((a, b) => b[1] - a[1]);
    const topTokens = sortedTokens.slice(0, 5).map(([token, count]) => `${token}:${count}`);
    console.warn(
      `[WARN:${code}] total=${total} unique=${tokens.size}` +
        (topTokens.length ? ` top=${topTokens.join(",")}` : "")
    );
  }
  warnAggregates.clear();
}

function recordWarnAggregate(code, token) {
  ensureAggregateTimer();
  const entry = warnAggregates.get(code) || { total: 0, tokens: new Map() };
  entry.total += 1;
  const tokenCount = entry.tokens.get(token) || 0;
  entry.tokens.set(token, tokenCount + 1);
  warnAggregates.set(code, entry);
}

export function logWarnOncePerToken(code, token, message, extras = {}) {
  const tokenStr = canonToken(token);
  if (!tokenStr) return;
  recordWarnAggregate(code, tokenStr);

  const key = `${code}:${tokenStr}`;
  const now = Date.now();
  const last = warnDedupe.get(key);
  if (last && now - last < TOKEN_WARN_TTL_MS) {
    return;
  }
  warnDedupe.set(key, now);

  const payload = Object.keys(extras).length ? ` ${JSON.stringify(extras)}` : "";
  console.warn(`[WARN:${code}] token=${tokenStr} ${message}${payload}`);
}

export function logWarn(context, message, extras = {}) {
  const payload = Object.keys(extras).length ? ` ${JSON.stringify(extras)}` : "";
  console.warn(`[${context}] ${message}${payload}`);
}

export function logError(context, err, extras = {}) {
  const message = err?.message || err;
  const key = `${context}:${message}`;
  const now = Date.now();
  const last = errorDedupe.get(key);
  if (last && now - last < ERROR_DEDUPE_TTL_MS) {
    return;
  }
  errorDedupe.set(key, now);

  const payload = Object.keys(extras).length ? ` ${JSON.stringify(extras)}` : "";
  console.error(`[${context}] ${message}${payload}`);
  if (err?.stack) {
    console.error(err.stack);
  }

  try {
    if (typeof sendNotification === "function") {
      sendNotification(`[ERROR] ${context}: ${message}`);
    }
  } catch (notifyErr) {
    console.error("[logError] Failed to send notification", notifyErr);
  }
}

export function flushLoggerAggregates() {
  flushWarnAggregates();
}
