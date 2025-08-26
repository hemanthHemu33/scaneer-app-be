import express from "express";
import {
  updateInterval,
  fetchIntraday,
  kiteRedirect,
} from "../controllers/systemController.js";

const router = express.Router();

router.post("/set-interval", updateInterval);
router.post("/fetch-intraday-data", fetchIntraday);
router.get("/kite-redirect", kiteRedirect);

export default router;
