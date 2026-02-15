export function systemNow() {
  return Date.now();
}

export function createBacktestClock(startMs = 0) {
  let cursor = Number.isFinite(startMs) ? startMs : 0;

  return {
    now() {
      return cursor;
    },
    set(ms) {
      if (Number.isFinite(ms)) cursor = ms;
      return cursor;
    },
    tick(stepMs = 0) {
      if (Number.isFinite(stepMs)) cursor += stepMs;
      return cursor;
    },
    toDate() {
      return new Date(cursor);
    },
  };
}

export function ensureClock(clockLike) {
  if (clockLike && typeof clockLike.now === 'function') {
    return clockLike;
  }
  return { now: systemNow };
}
