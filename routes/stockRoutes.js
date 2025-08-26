import express from "express";
import {
  addStockSymbol,
  getStockSymbols,
  deleteStockSymbol,
  resetCollections,
} from "../controllers/stockController.js";

const router = express.Router();

router.post("/addStockSymbol", addStockSymbol);
router.get("/stockSymbols", getStockSymbols);
router.delete("/stockSymbols/:symbol", deleteStockSymbol);
router.delete("/reset", resetCollections);

export default router;
