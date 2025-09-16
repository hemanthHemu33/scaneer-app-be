import db from "./db.js";
import { logError } from "./logger.js";
import { addSignal } from "./signalManager.js";
import { sendSignal as sendTelegram } from "./telegram.js";

function buildSignalFilter(result) {
  if (result?.insertedId) {
    return { _id: result.insertedId };
  }
  if (result?.signalId) {
    return { signalId: result.signalId };
  }
  return null;
}

export async function persistThenNotify(signal, { sendFn = sendTelegram } = {}) {
  const persistResult = await addSignal(signal);
  const filter = buildSignalFilter(persistResult);
  const sinks = { telegram: "pending" };

  if (filter) {
    await db.collection("signals").updateOne(filter, {
      $set: { sinks, updatedAt: new Date() },
      $setOnInsert: { createdAt: new Date() },
    });
  }

  try {
    if (typeof sendFn === "function") {
      await sendFn(signal);
    }
    sinks.telegram = "ok";
    if (filter) {
      await db
        .collection("signals")
        .updateOne(filter, { $set: { "sinks.telegram": "ok", updatedAt: new Date() } });
    }
  } catch (err) {
    sinks.telegram = "fail";
    sinks.telegram_error = err?.message || String(err);
    logError("emitter.telegram", err);
    if (filter) {
      await db.collection("signals").updateOne(filter, {
        $set: {
          "sinks.telegram": "fail",
          "sinks.telegram_error": sinks.telegram_error,
          updatedAt: new Date(),
        },
      });
    }
  }

  return { ...persistResult, sinks };
}
