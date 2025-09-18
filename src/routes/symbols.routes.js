// src/routes/symbols.routes.js
import { Router } from "express";
import {
  addStockSymbol,
  getStockSymbols,
  deleteStockSymbol,
} from "../controllers/symbols.controller.js";
const router = Router();
router.post("/addStockSymbol", addStockSymbol);
router.get("/stockSymbols", getStockSymbols);
router.delete("/stockSymbols/:symbol", deleteStockSymbol);
export default router;
