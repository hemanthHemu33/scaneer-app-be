import express from "express";
import cors from "cors";
import stockRoutes from "./routes/stockRoutes.js";
import signalRoutes from "./routes/signalRoutes.js";
import systemRoutes from "./routes/systemRoutes.js";

export const allowedOrigins = [
  "https://scanner-app-fe.onrender.com",
  "http://localhost:5600",
];

const app = express();

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    methods: ["GET", "POST", "DELETE"],
    credentials: true,
  })
);

app.use(express.json());

app.use(stockRoutes);
app.use(signalRoutes);
app.use(systemRoutes);

export default app;
