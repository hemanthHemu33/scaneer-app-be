// src/routes/market.routes.js
import { Router } from "express";
import {
  setIntervalController,
  fetchIntradayData,
} from "../controllers/market.controller.js";
const router = Router();
router.post("/set-interval", setIntervalController);
router.post("/fetch-intraday-data", fetchIntradayData);
export default router;
