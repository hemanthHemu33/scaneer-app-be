// src/sockets/io.js
import { Server } from "socket.io";
import { corsOptions } from "../config/cors.js";

let io;

export function initIO(server) {
  io = new Server(server, { cors: corsOptions });
  io.on("connection", (socket) => {
    console.log("✅ Client connected:", socket.id);
    socket.emit("serverMessage", "Connected to backend.");
  });
  return io;
}

export function getIO() {
  if (!io) throw new Error("Socket.io not initialized");
  return io;
}
