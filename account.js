// account.js
// Provides utilities for fetching and caching account related data
import { kc, initSession } from "./kite.js";
import { toISTDate } from "./util.js";

let accountBalance = 0;
let equityPeak = 0;
let lastSnapshotAt = 0;
let lastPnlResetDate = null;
let realizedPnlToday = 0;

const MARGIN_CACHE_TTL_MS = Number(process.env.MARGIN_CACHE_TTL_MS) || 15_000;
const BALANCE_OVERRIDE =
  (process.env.ACCOUNT_BALANCE_OVERRIDE &&
    Number(process.env.ACCOUNT_BALANCE_OVERRIDE)) ||
  null;

function maybeResetDailyPnlClock() {
  const today = toISTDate(new Date());
  if (lastPnlResetDate !== today) {
    realizedPnlToday = 0;
    lastPnlResetDate = today;
  }
}

function extractNetBalance(margin) {
  // Prefer a broker-reported net; fall back to available cash buckets if present
  if (typeof margin?.net === "number" && Number.isFinite(margin.net)) return margin.net;
  const eq = margin?.equity || margin?.segment?.equity;
  const avail = eq?.available || {};
  const candidates = [
    avail.net,
    avail.cash,
    avail.live_balance,
    avail.opening_balance,
  ].filter((v) => typeof v === "number" && Number.isFinite(v));
  if (candidates.length) return candidates[0];
  return 0;
}

// Fetch margin available across equity using the shared Kite instance
export async function getAccountMargin() {
  try {
    await initSession();
    const response = await kc.getMargins("equity");
    return response;
  } catch (err) {
    console.error(`[ACCOUNT] Error fetching account margin`, err?.message || err);
    return null;
  }
}

export function getAccountBalance() {
  return accountBalance;
}

export function getEquityPeak() {
  return equityPeak || accountBalance || 0;
}

export function getDrawdown() {
  const peak = getEquityPeak();
  if (!peak) return 0;
  const eq = accountBalance;
  return Math.max(0, (peak - eq) / peak);
}

export function getRealizedPnlToday() {
  maybeResetDailyPnlClock();
  return realizedPnlToday;
}

export function applyRealizedPnL(pnl = 0) {
  if (!Number.isFinite(pnl) || pnl === 0) return accountBalance;
  maybeResetDailyPnlClock();
  realizedPnlToday += pnl;
  accountBalance = Math.max(0, (accountBalance || 0) + pnl);
  if (accountBalance > (equityPeak || 0)) equityPeak = accountBalance;
  return accountBalance;
}

export async function refreshAccountBalance({ force = false } = {}) {
  // Manual override for sim/testing
  if (BALANCE_OVERRIDE != null) {
    accountBalance = BALANCE_OVERRIDE;
    equityPeak = Math.max(equityPeak, accountBalance);
    return accountBalance;
  }
  const now = Date.now();
  if (!force && now - lastSnapshotAt < MARGIN_CACHE_TTL_MS) {
    return accountBalance;
  }
  try {
    const margin = await getAccountMargin();
    const net = extractNetBalance(margin);
    accountBalance = Number.isFinite(net) ? net : 0;
    equityPeak = Math.max(equityPeak || 0, accountBalance);
    lastSnapshotAt = now;
  } catch (e) {
    console.error(`[ACCOUNT] refresh failed`, e?.message || e);
  }
  return accountBalance;
}

export async function initAccountBalance() {
  try {
    await refreshAccountBalance({ force: true });
    console.log(
      `[ACCOUNT] Account balance initialized: ${accountBalance} (peak=${equityPeak})`
    );
  } catch (err) {
    console.error(`[ACCOUNT] Failed to fetch margin`, err?.message || err);
    accountBalance = 0;
  }
  return accountBalance;
}
