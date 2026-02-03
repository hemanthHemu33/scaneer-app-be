export const activeSignals = new Map(); // symbol -> Map<signalId, info>
import { sendNotification } from './telegram.js';
import { logSignalExpired, logSignalMutation } from './auditLogger.js';
import db from './db.js';
import { logError } from './logger.js';

const DEFAULT_EXPIRY_MINUTES = Number(process.env.SIGNAL_DEFAULT_EXPIRY_MINUTES) || 5;

function resolveExpiryMs(signal) {
  const candidate = signal.expiresAt || signal.algoSignal?.expiresAt;
  const resolved = candidate ? new Date(candidate).getTime() : NaN;
  if (Number.isFinite(resolved)) return resolved;
  return Date.now() + DEFAULT_EXPIRY_MINUTES * 60 * 1000;
}

export async function addSignal(signal) {
  const symbol = signal.stock || signal.symbol;
  const direction = signal.direction || (signal.side === 'buy' ? 'Long' : 'Short');
  const confidence = signal.confidence || signal.confidenceScore || 0;
  const expiresAt = resolveExpiryMs(signal);
  const signalId = signal.signalId || signal.algoSignal?.signalId || `${symbol}-${Date.now()}`;

  let symbolMap = activeSignals.get(symbol);
  if (!symbolMap) {
    symbolMap = new Map();
    activeSignals.set(symbol, symbolMap);
  }
  for (const info of symbolMap.values()) {
    if (info.status === 'active' && info.direction !== direction) {
      if ((info.confidence || 0) >= confidence) {
        return false; // keep existing stronger signal
      }
      info.status = 'cancelled';
      logSignalMutation(info.signal.signalId || info.signal.algoSignal?.signalId, {
        fieldChanged: 'status',
        oldValue: 'active',
        newValue: 'cancelled',
        reason: 'conflict',
        timestamp: new Date().toISOString(),
      });
      sendNotification && sendNotification(`Signal for ${symbol} cancelled due to conflict`);
      try {
        await db.collection('active_signals').updateOne(
          { signalId: info.signal.signalId || info.signal.algoSignal?.signalId },
          { $set: { status: 'cancelled', updatedAt: new Date() } },
          { upsert: true }
        );
      } catch (err) {
        logError('DB update failed', err);
      }
    }
  }

  symbolMap.set(signalId, {
    signal,
    status: 'active',
    direction,
    confidence,
    expiresAt,
  });

  let insertedSignal = null;
  try {
    await db.collection('active_signals').updateOne(
      { signalId },
      {
        $set: {
          signal,
          symbol,
          direction,
          confidence,
          expiresAt: new Date(expiresAt),
          status: 'active',
          updatedAt: new Date(),
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true }
    );
    const result = await db.collection('signals').insertOne({
      ...signal,
      signalId,
      symbol,
      direction,
      confidence,
      expiresAt: new Date(expiresAt),
      generatedAt: signal.generatedAt ? new Date(signal.generatedAt) : new Date(),
    });
    insertedSignal = result;
  } catch (err) {
    logError('DB insert failed', err);
  }
  return {
    ok: Boolean(insertedSignal?.acknowledged),
    insertedId: insertedSignal?.insertedId || null,
    signalId,
  };
}

export async function checkExpiries(now = Date.now()) {
  for (const [symbol, sigMap] of activeSignals.entries()) {
    for (const [id, info] of sigMap.entries()) {
      if (info.status === 'active' && info.expiresAt && now > info.expiresAt) {
        info.status = 'expired';
        sendNotification && sendNotification(`Signal for ${symbol} expired`);
        logSignalExpired(
          info.signal.signalId || info.signal.algoSignal?.signalId,
          {
            reason: 'timeExpiry',
            lastPrice: info.signal.entry,
            atr: info.signal.atr,
            confidenceAtExpiry: info.signal.confidence,
            category: 'naturalExpiry',
          }
        );
        try {
          await db.collection('active_signals').updateOne(
            { signalId: info.signal.signalId || info.signal.algoSignal?.signalId },
            { $set: { status: 'expired', updatedAt: new Date(now) } }
          );
        } catch (err) {
          logError('DB expiry update failed', err);
        }
        sigMap.delete(id);
      }
    }
    if (sigMap.size === 0) {
      activeSignals.delete(symbol);
    }
  }
}

let expiryInterval = null;
if (process.env.NODE_ENV !== 'test') {
  expiryInterval = setInterval(() => checkExpiries(), 60 * 1000);
}
export { expiryInterval };
