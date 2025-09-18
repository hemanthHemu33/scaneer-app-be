import { setTickInterval, fetchHistoricalIntradayData } from "../kite.js";
import { logError } from "../logger.js";

export const setIntervalController = (req, res) => {
  const { interval } = req.body;
  if (typeof interval === "number" && interval > 0) {
    setTickInterval(interval);
    res.json({ status: "Interval updated", interval });
  } else {
    res.status(400).json({ error: "Invalid interval" });
  }
};

export const fetchIntradayData = async (req, res) => {
  const { interval = "minute", days = 3 } = req.body || {};
  try {
    await fetchHistoricalIntradayData(interval, days);
    res.json({ status: "success" });
  } catch (err) {
    logError("intraday fetch", err);
    res.status(500).json({ error: "Failed to fetch intraday data" });
  }
};
