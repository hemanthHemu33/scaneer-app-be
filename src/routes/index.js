import { Router } from "express";
import healthRoutes from "./health.routes.js";
import symbolsRoutes from "./symbols.routes.js";
import signalsRoutes from "./signals.routes.js";
import marketRoutes from "./market.routes.js";
import authRoutes from "./auth.routes.js";
import adminRoutes from "./admin.routes.js";

const router = Router();
router.use(healthRoutes);
router.use(symbolsRoutes);
router.use(signalsRoutes);
router.use(marketRoutes);
router.use(authRoutes);
router.use(adminRoutes);

export default router;
