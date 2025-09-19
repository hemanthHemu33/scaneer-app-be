import db from "../db.js";
import { isMarketOpen, startLiveFeed, kc, isLiveFeedRunning } from "../kite.js";
import { logError } from "../logger.js";
import { getIO } from "../sockets/io.js";

const apiSecret = process.env.KITE_API_SECRET;

export const kiteRedirect = async (req, res) => {
  const requestToken = req.query.request_token;
  if (!requestToken)
    return res.status(400).json({ error: "Missing request_token" });

  try {
    const session = await kc.generateSession(requestToken, apiSecret);
    kc.setAccessToken(session.access_token);

    await db
      .collection("tokens")
      .updateOne(
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

    if (isMarketOpen() && !isLiveFeedRunning()) {
      startLiveFeed(getIO());
    } else if (isMarketOpen()) {
      console.log("ℹ️ Live feed already running; skipping duplicate start.");
    }
    return res.send("✅ Login successful, session created.");
  } catch (err) {
    logError("kite redirect", err);
    return res.status(500).json({ error: "Login failed" });
  }
};
