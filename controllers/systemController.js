import { setTickInterval, fetchHistoricalIntradayData, kc, isMarketOpen, startLiveFeed } from "../kite.js";
import db from "../db.js";
import { logError } from "../logger.js";

const apiSecret = process.env.KITE_API_SECRET;

export function updateInterval(req, res) {
  const { interval } = req.body;
  if (typeof interval === "number" && interval > 0) {
    setTickInterval(interval);
    res.json({ status: "Interval updated", interval });
  } else {
    res.status(400).json({ error: "Invalid interval" });
  }
}

export async function fetchIntraday(req, res) {
  const { interval = "minute", days = 3 } = req.body || {};
  try {
    await fetchHistoricalIntradayData(interval, days);
    res.json({ status: "success" });
  } catch (err) {
    logError("intraday fetch", err);
    res.status(500).json({ error: "Failed to fetch intraday data" });
  }
}

export async function kiteRedirect(req, res) {
  const requestToken = req.query.request_token;
  if (!requestToken) {
    return res.status(400).json({ error: "Missing request_token" });
  }
  try {
    const session = await kc.generateSession(requestToken, apiSecret);
    kc.setAccessToken(session.access_token);
    await db.collection("tokens").updateOne(
      { type: "kite_session" },
      {
        $set: {
          ...session,
          request_token: requestToken,
          type: "kite_session",
        },
      },
      { upsert: true }
    );
    if (isMarketOpen()) {
      const io = req.app.get("io");
      startLiveFeed(io);
    }
    return res.send("✅ Login successful, session created.");
  } catch (err) {
    logError("kite redirect", err);
    return res
      .status(500)
      .send("❌ Login failed: " + (err.message || "Unknown error"));
  }
}
