// src/routes/admin.routes.js
import { Router } from "express";
import { resetAllCollections } from "../controllers/admin.controller.js";
const router = Router();
router.delete("/reset", resetAllCollections);
export default router;
