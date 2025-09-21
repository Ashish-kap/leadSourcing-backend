import express from "express";
import {
  createFeedback,
  getAllFeedback,
  getMyFeedback,
  getFeedback,
  deleteFeedback,
  getSatisfactionAnalytics,
} from "../api/controllers/feedbackController.js";
import { protect } from "../api/controllers/authController.js";

const router = express.Router();

// All routes require authentication
router.use(protect);

// User routes
router.route("/").post(createFeedback);
router.route("/my-feedback").get(getMyFeedback);

// Admin routes (add admin middleware if needed)
router.route("/").get(getAllFeedback);
router.route("/analytics").get(getSatisfactionAnalytics);
router.route("/:id").get(getFeedback).delete(deleteFeedback);

export default router;
