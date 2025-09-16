import crypto from 'crypto';
import db from './db.js';
import { sendNotification } from './telegram.js';
import { onReject } from './metrics.js';

const LOG_COLLECTION = 'audit_logs';
const ARCHIVE_COLLECTION = 'audit_logs_archive';
const KEY_HEX = process.env.LOG_ENCRYPTION_KEY || '0000000000000000000000000000000000000000000000000000000000000000';
const KEY = Buffer.from(KEY_HEX, 'hex');

function encrypt(data) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', KEY, iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  return { iv: iv.toString('hex'), content: enc.toString('hex') };
}

function decrypt(obj) {
  const decipher = crypto.createDecipheriv('aes-256-cbc', KEY, Buffer.from(obj.iv, 'hex'));
  const dec = Buffer.concat([decipher.update(Buffer.from(obj.content, 'hex')), decipher.final()]);
  return JSON.parse(dec.toString());
}

export async function secureLogStore(entry, sensitive = []) {
  const log = { ...entry, timestamp: new Date().toISOString() };
  const secureObj = {};
  for (const f of sensitive) {
    if (log[f] !== undefined) {
      secureObj[f] = log[f];
      delete log[f];
    }
  }
  if (Object.keys(secureObj).length) {
    log.secure = encrypt(secureObj);
  }
  await db.collection(LOG_COLLECTION).insertOne(log);
}

export async function logSignalCreated(signalData, marketCtx = {}) {
  await secureLogStore({
    type: 'signal_created',
    signalId: signalData.signalId || signalData.algoSignal?.signalId,
    signalType: signalData.pattern || signalData.strategy,
    symbol: signalData.stock || signalData.symbol,
    strategy: signalData.pattern || signalData.strategy,
    entryPrice: signalData.entry,
    stopLoss: signalData.stopLoss,
    targetPrice: signalData.target2 || signalData.target,
    confidence: signalData.confidence || signalData.confidenceScore,
    timeframe: signalData.timeframe || '1m',
    market: {
      vix: marketCtx.vix,
      atr: signalData.atr,
      trend: marketCtx.regime,
      volume: signalData.liquidity,
      marketBreadth: marketCtx.breadth,
    },
  });
}

export async function logSignalMutation(signalId, mutationDetails) {
  await secureLogStore({
    type: 'signal_mutation',
    signalId,
    mutation: mutationDetails,
  });
}

export async function logSignalExpired(signalId, reason) {
  await secureLogStore({
    type: 'signal_expired',
    signalId,
    reason,
  });
  if (reason.category && reason.category !== 'naturalExpiry') {
    sendCriticalAlerts('expiry', { signalId, reason });
  }
}

export async function logSignalRejected(
  signalId,
  reasonCode,
  validationDetails,
  signalData = null
) {
  onReject(reasonCode);
  await secureLogStore(
    {
      type: 'signal_rejected',
      signalId,
      rejectionType: validationDetails?.manual ? 'manual' : 'auto',
      reasonCode,
      validationDetails,
    },
    ['validationDetails']
  );
  try {
    await db.createCollection('rejected_signals');
  } catch {}
  try {
    await db.collection('rejected_signals').insertOne({
      signalId,
      reasonCode,
      validationDetails,
      signal: signalData,
      timestamp: new Date(),
    });
  } catch (e) {
    console.error('Failed to store rejected signal', e.message);
  }
}

export async function logBacktestReference(params, results) {
  await secureLogStore({
    type: 'backtest_reference',
    environment: 'backtest',
    ...params,
    results,
  });
}

export async function getLogs(query = {}) {
  const { limit = 100, ...q } = query;
  const logs = await db
    .collection(LOG_COLLECTION)
    .find(q)
    .sort({ timestamp: -1 })
    .limit(limit)
    .toArray();
  return logs.map((l) => {
    if (l.secure) {
      Object.assign(l, decrypt(l.secure));
      delete l.secure;
    }
    return l;
  });
}

export function sendCriticalAlerts(eventType, payload) {
  const msg = `[ALERT] ${eventType.toUpperCase()} - ${payload.signalId || ''}`;
  sendNotification(msg);
}

async function archiveOldLogs() {
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const old = await db
    .collection(LOG_COLLECTION)
    .find({ timestamp: { $lt: cutoff } })
    .toArray();
  if (old.length) {
    await db.collection(ARCHIVE_COLLECTION).insertMany(old);
    await db
      .collection(LOG_COLLECTION)
      .deleteMany({ _id: { $in: old.map((o) => o._id) } });
  }
}

async function setupIndexes() {
  try {
    await db
      .collection(ARCHIVE_COLLECTION)
      .createIndex({ timestamp: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 730 });
  } catch (e) {
    console.error('Index setup failed', e.message);
  }
}

if (process.env.NODE_ENV !== 'test') {
  setupIndexes();
  setInterval(() => archiveOldLogs().catch(() => {}), 24 * 60 * 60 * 1000);
}
