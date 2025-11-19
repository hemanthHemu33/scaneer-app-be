import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";

import {
  scoreSwingOpportunity,
  DEFAULT_SWING_THRESHOLD,
} from "./swingTrader.js";

dayjs.extend(utc);
dayjs.extend(timezone);

const parseBool = (value, fallback) => {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    return !["false", "0", "off", "no", "disabled"].includes(
      value.toLowerCase()
    );
  }
  return fallback;
};

const parseNumber = (value) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

const defaultConfig = {
  enabled: parseBool(process.env.AUTO_EXECUTE, true),
  minConfidence: parseNumber(process.env.AUTO_TRADE_MIN_CONFIDENCE),
  maxOpenTrades: parseNumber(process.env.AUTO_TRADE_MAX_OPEN),
  intradayOnly: parseBool(process.env.AUTO_TRADE_INTRADAY_ONLY, true),
  minSwingScore:
    parseNumber(process.env.AUTO_TRADE_MIN_SWING_SCORE) ?? DEFAULT_SWING_THRESHOLD,
};

let config = { ...defaultConfig };

const cloneConfig = () => ({ ...config });

export function getAutoTradingConfig() {
  return cloneConfig();
}

export function updateAutoTradingConfig(patch = {}) {
  const next = cloneConfig();
  if ("enabled" in patch) next.enabled = Boolean(patch.enabled);
  if ("minConfidence" in patch) {
    const num = parseNumber(patch.minConfidence);
    if (num !== null) next.minConfidence = Math.max(0, num);
  }
  if ("maxOpenTrades" in patch) {
    const num = parseNumber(patch.maxOpenTrades);
    if (num !== null && num > 0) next.maxOpenTrades = Math.floor(num);
  }
  if ("intradayOnly" in patch) next.intradayOnly = Boolean(patch.intradayOnly);
  if ("minSwingScore" in patch) {
    const num = parseNumber(patch.minSwingScore);
    next.minSwingScore = num !== null ? Math.max(0, Math.min(1, num)) : null;
  }
  config = next;
  return cloneConfig();
}

export function resetAutoTradingConfig() {
  config = { ...defaultConfig };
  return cloneConfig();
}

export function evaluateAutoTradeEligibility(signal = {}) {
  if (!config.enabled) return { ok: false, reason: "disabled" };
  const confidence =
    signal.confidence ?? signal.confidenceScore ?? signal.algoSignal?.confidence;
  if (
    config.minConfidence !== null &&
    confidence !== undefined &&
    confidence < config.minConfidence
  ) {
    return { ok: false, reason: "confidence" };
  }
  if (config.intradayOnly) {
    const expiry = signal.expiresAt || signal.algoSignal?.expiresAt;
    if (expiry) {
      const expiryDay = dayjs(expiry).tz("Asia/Kolkata").format("YYYY-MM-DD");
      const today = dayjs().tz("Asia/Kolkata").format("YYYY-MM-DD");
      if (expiryDay !== today) return { ok: false, reason: "expiry" };
    }
  }
  if (config.minSwingScore !== null) {
    const swingScore =
      typeof signal.swingScore === "number"
        ? signal.swingScore
        : scoreSwingOpportunity(signal).score;
    if (swingScore < config.minSwingScore) {
      return { ok: false, reason: "swing", swingScore };
    }
  }
  return { ok: true };
}

export function getMaxOpenTradesOverride() {
  return config.maxOpenTrades && config.maxOpenTrades > 0
    ? config.maxOpenTrades
    : null;
}
