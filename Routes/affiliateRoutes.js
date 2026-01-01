import express from "express";
import * as affiliateController from "../api/controllers/affiliateController.js";
import * as authController from "../api/controllers/authController.js";

const router = express.Router();

// User endpoint - requires authentication
router.get("/me", authController.protect, affiliateController.getAffiliateDashboard);

// Admin endpoint - requires authentication + admin role
router.post(
  "/payout",
  authController.protect,
  authController.restrictTo("admin"),
  affiliateController.markPayoutsAsPaid
);

export default router;

