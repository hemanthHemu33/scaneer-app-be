// src/routes/signals.routes.js
import { Router } from "express";
import {
  listSignals,
  getSignalsHistory,
} from "../controllers/signals.controller.js";
const router = Router();
router.get("/signals", listSignals);
router.get("/signal-history", getSignalsHistory);
export default router;
