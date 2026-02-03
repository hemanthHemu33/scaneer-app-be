import { logError, logWarn } from "../../logger.js";

/**
 * Publishes signals to the execution service with basic de-duplication.
 */
export class SignalPublisher {
  constructor({ endpoint, dedupeMs = 10_000 } = {}) {
    this.endpoint = endpoint;
    this.dedupeMs = dedupeMs;
    this.lastSent = new Map(); // symbol -> timestamp
  }

  async publish(signal) {
    if (!signal?.symbol || !signal?.side) return;
    const last = this.lastSent.get(signal.symbol);
    const now = Date.now();
    if (last && now - last < this.dedupeMs) {
      logWarn("SignalPublisher", `Skipping duplicate signal for ${signal.symbol}`);
      return;
    }

    try {
      const res = await fetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(signal),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
      }
      this.lastSent.set(signal.symbol, now);
    } catch (err) {
      logError("SignalPublisher", err, { endpoint: this.endpoint });
    }
  }
}
