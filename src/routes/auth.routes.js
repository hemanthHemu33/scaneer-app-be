// src/routes/auth.routes.js
import { Router } from "express";
import { kiteRedirect } from "../controllers/auth.controller.js";
const router = Router();
router.get("/kite-redirect", kiteRedirect);
export default router;
