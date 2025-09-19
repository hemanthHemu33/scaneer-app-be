export function createLiveFeedMonitor({
  isMarketOpen,
  isLiveFeedRunning,
  startLiveFeed,
  logger = console,
  intervalMs = 60_000,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  if (typeof isMarketOpen !== "function") {
    throw new TypeError("isMarketOpen must be a function");
  }
  if (typeof isLiveFeedRunning !== "function") {
    throw new TypeError("isLiveFeedRunning must be a function");
  }
  if (typeof startLiveFeed !== "function") {
    throw new TypeError("startLiveFeed must be a function");
  }

  let timer = null;
  let lastOpenState = null;
  let ioRef;

  const log = (message) => {
    if (!logger) return;
    const fn =
      typeof logger.log === "function"
        ? logger.log
        : typeof logger.info === "function"
        ? logger.info
        : null;
    if (fn) {
      fn.call(logger, message);
    }
  };

  const evaluate = (io) => {
    if (io !== undefined) {
      ioRef = io;
    }

    const open = Boolean(isMarketOpen());

    if (open) {
      if (lastOpenState !== true) {
        log("🔓 Market open detected; ensuring live feed is running.");
      }
      lastOpenState = true;

      if (!isLiveFeedRunning()) {
        log("🚀 Market open and live feed offline; starting automatically.");
        if (ioRef) {
          startLiveFeed(ioRef);
        } else {
          log("⚠️ No IO context available for live feed start.");
        }
      }
    } else {
      if (lastOpenState !== false) {
        log("🛑 Market closed; live feed monitor standing by.");
      }
      lastOpenState = false;
    }
  };

  const start = (io) => {
    if (io !== undefined) {
      ioRef = io;
    }
    if (timer) return timer;

    timer = setIntervalFn(() => evaluate(), intervalMs);
    timer.unref?.();
    return timer;
  };

  const stop = () => {
    if (!timer) return;
    clearIntervalFn(timer);
    timer = null;
  };

  const isRunning = () => timer !== null;

  return {
    start,
    stop,
    evaluate,
    isRunning,
  };
}
