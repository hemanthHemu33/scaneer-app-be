export const activeSignals = new Map(); // symbol -> Map<signalId, info>
import { sendNotification } from './telegram.js';
import { logSignalExpired, logSignalMutation } from './auditLogger.js';

export function addSignal(signal) {
  const symbol = signal.stock || signal.symbol;
  const direction = signal.direction || (signal.side === 'buy' ? 'Long' : 'Short');
  const confidence = signal.confidence || signal.confidenceScore || 0;
  const expiresAt = new Date(signal.expiresAt || signal.algoSignal?.expiresAt).getTime();
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
    }
  }

  symbolMap.set(signalId, {
    signal,
    status: 'active',
    direction,
    confidence,
    expiresAt,
  });
  return true;
}

export function checkExpiries(now = Date.now()) {
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
      }
    }
  }
}

let expiryInterval = null;
if (process.env.NODE_ENV !== 'test') {
  expiryInterval = setInterval(() => checkExpiries(), 60 * 1000);
}
export { expiryInterval };

