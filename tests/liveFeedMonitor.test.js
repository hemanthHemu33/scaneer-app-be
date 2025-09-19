import test from "node:test";
import assert from "node:assert/strict";
import { createLiveFeedMonitor } from "../liveFeedMonitor.js";

test("auto-starts live feed when market opens after being offline", () => {
  let marketOpen = false;
  let running = false;
  const logs = [];
  const ioContext = { foo: "bar" };
  const startCalls = [];

  const monitor = createLiveFeedMonitor({
    isMarketOpen: () => marketOpen,
    isLiveFeedRunning: () => running,
    startLiveFeed: (ctx) => {
      startCalls.push(ctx);
      running = true;
    },
    logger: { log: (msg) => logs.push(msg) },
  });

  monitor.evaluate(ioContext);
  assert.ok(
    logs.some((msg) => msg.includes("Market closed")),
    "should log closed state on initial evaluation"
  );

  logs.length = 0;
  marketOpen = true;
  running = false;
  monitor.evaluate();
  assert.equal(startCalls.length, 1, "should start feed when market opens");
  assert.strictEqual(startCalls[0], ioContext, "should reuse last IO context");
  assert.ok(
    logs.some((msg) => msg.includes("starting automatically")),
    "should log automatic start"
  );

  logs.length = 0;
  monitor.evaluate();
  assert.equal(
    startCalls.length,
    1,
    "should not restart feed while it is reported running"
  );

  running = false;
  monitor.evaluate();
  assert.equal(startCalls.length, 2, "should restart when feed stops again");

  marketOpen = false;
  monitor.evaluate();
  assert.ok(
    logs.some((msg) => msg.includes("Market closed")),
    "should log transition when market closes"
  );

  monitor.stop();
});

test("start/stop manage interval lifecycle", () => {
  let scheduledFn;
  const fakeTimer = { id: 1 };
  let clearedCount = 0;

  const monitor = createLiveFeedMonitor({
    isMarketOpen: () => false,
    isLiveFeedRunning: () => false,
    startLiveFeed: () => {},
    logger: null,
    setIntervalFn: (fn, ms) => {
      scheduledFn = fn;
      assert.equal(ms, 60_000);
      return fakeTimer;
    },
    clearIntervalFn: (handle) => {
      assert.strictEqual(handle, fakeTimer);
      clearedCount += 1;
    },
  });

  monitor.start({});
  assert.equal(typeof scheduledFn, "function", "should schedule interval callback");
  assert.equal(monitor.isRunning(), true, "should report running state");

  monitor.start({});
  assert.equal(clearedCount, 0, "should not reschedule when already running");

  monitor.stop();
  assert.equal(monitor.isRunning(), false, "should clear running state on stop");
  assert.equal(clearedCount, 1, "should clear interval handle exactly once");
});
