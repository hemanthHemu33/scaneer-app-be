import http from "http";
import { Server } from "socket.io";
import cron from "node-cron";
import app, { allowedOrigins } from "./app.js";
import { startLiveFeed, isMarketOpen, preloadStockData } from "./kite.js";
import { trackOpenPositions } from "./portfolioContext.js";

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    methods: ["GET", "POST", "DELETE"],
    credentials: true,
  },
});

app.set("io", io);

io.on("connection", (socket) => {
  console.log("✅ Client connected:", socket.id);
  socket.emit("serverMessage", "Connected to backend.");
});

server.listen(3000, () => {
  console.log("📡 Backend running on port 3000");

  if (isMarketOpen()) {
    console.log("✅ Market is open. Starting live feed...");
    startLiveFeed(io);
  } else {
    console.log("⏸ Market is closed. Skipping live feed start.");
  }

  if (process.env.NODE_ENV !== "test") {
    const dummyBroker = { getPositions: async () => [] };
    trackOpenPositions(dummyBroker);
    setInterval(() => trackOpenPositions(dummyBroker), 60 * 1000);
  }

  cron.schedule(
    "30 8 * * 1-5",
    () => {
      preloadStockData();
    },
    { timezone: "Asia/Kolkata" }
  );

  const now = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" })
  );
  const minutes = now.getHours() * 60 + now.getMinutes();
  if (minutes >= 510 && minutes <= 540) {
    preloadStockData();
  }
});
