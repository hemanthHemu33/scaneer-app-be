// src/index.js
import express from "express";
import http from "http";
import { corsOptions } from "./config/cors.js";
import router from "./routes/index.js";
import { initIO } from "./sockets/io.js";
import cors from "cors";
import { runStartup } from "./bootstrap/startup.js";

const app = express();
app.use(cors(corsOptions));
app.use(express.json());
app.use(router); // all endpoints preserved

const server = http.createServer(app);
const io = initIO(server); // same socket behavior

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`📡 Backend running on port ${PORT}`);
  runStartup(io); // everything you had in server.listen moved here
});
