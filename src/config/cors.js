// src/config/cors.js
export const allowedOrigins = [
  "https://scanner-app-fe.onrender.com",
  "http://localhost:5600",
];

export const corsOptions = {
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) callback(null, true);
    else callback(new Error("Not allowed by CORS"));
  },
  methods: ["GET", "POST", "DELETE"],
  credentials: true,
};
