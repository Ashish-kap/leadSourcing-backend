import express from "express";
import * as authController from "./../api/controllers/authController.js";
import {
  createSubscription,
  cancelSubscription,
} from "./../api/controllers/dodoPaymentsController.js";

const router = express.Router();

router.use(authController.protect);

router.post("/subscriptions", createSubscription);
router.patch("/subscriptions/:subscriptionId", cancelSubscription);

export default router;
