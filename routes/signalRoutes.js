import express from "express";
import { listSignals, signalHistory } from "../controllers/signalController.js";

const router = express.Router();

router.get("/signals", listSignals);
router.get("/signal-history", signalHistory);

export default router;
