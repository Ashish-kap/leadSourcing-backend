import express from "express";
import {
  getCreditStatus,
  checkCredits,
  allocateCredits,
  triggerMonthlyAllocation,
  triggerMonthlyReset,
  getJobStatus,
  getCreditAllocationInfo,
  getCreditHistory,
  downgradeUser,
  updateSubscriptionStatus,
} from "../api/controllers/creditsController.js";
import { protect } from "../api/controllers/authController.js";

const router = express.Router();

// All routes require authentication
router.use(protect);

// User routes
router.get("/status", getCreditStatus);
router.post("/check", checkCredits);
router.get("/allocation-info", getCreditAllocationInfo);
router.get("/history", getCreditHistory);

// Admin routes
router.post("/allocate", allocateCredits);
router.post("/trigger-monthly", triggerMonthlyAllocation);
router.post("/trigger-reset", triggerMonthlyReset);
router.get("/job-status", getJobStatus);
router.post("/downgrade", downgradeUser);
router.post("/subscription-status", updateSubscriptionStatus);

export default router;
