import { sendNotification } from './telegram.js';

export function logError(context, err) {
  console.error(`[${context}]`, err);
  try {
    if (sendNotification) {
      sendNotification(`[ERROR] ${context}: ${err.message || err}`);
    }
  } catch (e) {
    console.error('[logError] Failed to send notification', e);
  }
}
