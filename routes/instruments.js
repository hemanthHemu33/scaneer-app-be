// //

// // ***********************************************************************************************************
// import express from "express";
// import fs from "fs";
// import path from "path";

// const router = express.Router();

// // Nifty 50 symbols
// const nifty50Symbols = [
//   "NSE:ADANIENT",
//   "NSE:ADANIPORTS",
//   "NSE:APOLLOHOSP",
//   "NSE:ASIANPAINT",
//   "NSE:AXISBANK",
//   "NSE:BAJAJ-AUTO",
//   "NSE:BAJFINANCE",
//   "NSE:BAJAJFINSV",
//   "NSE:BEL",
//   "NSE:BHARTIARTL",
//   "NSE:CIPLA",
//   "NSE:COALINDIA",
//   "NSE:DRREDDY",
//   "NSE:EICHERMOT",
//   "NSE:ETERNAL",
//   "NSE:GRASIM",
//   "NSE:HCLTECH",
//   "NSE:HDFCBANK",
//   "NSE:HDFCLIFE",
//   "NSE:HEROMOTOCO",
//   "NSE:HINDALCO",
//   "NSE:HINDUNILVR",
//   "NSE:ICICIBANK",
//   "NSE:INDUSINDBK",
//   "NSE:INFY",
//   "NSE:ITC",
//   "NSE:JIOFIN",
//   "NSE:JSWSTEEL",
//   "NSE:KOTAKBANK",
//   "NSE:LT",
//   "NSE:M&M",
//   "NSE:MARUTI",
//   "NSE:NESTLEIND",
//   "NSE:NTPC",
//   "NSE:ONGC",
//   "NSE:POWERGRID",
//   "NSE:RELIANCE",
//   "NSE:SBILIFE",
//   "NSE:SHRIRAMFIN",
//   "NSE:SBIN",
//   "NSE:SUNPHARMA",
//   "NSE:TCS",
//   "NSE:TATACONSUM",
//   "NSE:TATAMOTORS",
//   "NSE:TATASTEEL",
//   "NSE:TECHM",
//   "NSE:TITAN",
//   "NSE:TRENT",
//   "NSE:ULTRACEMCO",
//   "NSE:WIPRO",
// ];

// router.get("/", (req, res) => {
//   try {
//     const instrumentsPath = path.join(
//       process.cwd(),
//       "scanner-app/backend/routes/instruments.json"
//     );
//     const data = JSON.parse(fs.readFileSync(instrumentsPath, "utf8"));
//     const niftyInstruments = data
//       .filter((row) => nifty50Symbols.includes(`NSE:${row.tradingsymbol}`))
//       .map((row) => ({
//         name: row.tradingsymbol,
//         token: parseInt(row.instrument_token),
//       }));

//     res.json(niftyInstruments);
//   } catch (err) {
//     console.error("❌ Error reading instruments:", err);
//     res.status(500).json({ error: "Failed to read instruments." });
//   }
// });

// export default router;
