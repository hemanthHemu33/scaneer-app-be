import db from "../db.js";
import { getSignalHistory } from "../scanner.js";
import { logError } from "../logger.js";

export const listSignals = async (req, res) => {
  try {
    const signals = await db
      .collection("signals")
      .find({})
      .sort({ generatedAt: -1 })
      .toArray();
    res.json({ status: "success", signals });
  } catch (err) {
    logError("fetching signals", err);
    res.status(500).json({ error: "Failed to fetch signals" });
  }
};

export const getSignalsHistory = (req, res) => {
  res.json(getSignalHistory());
};
