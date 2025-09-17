import express from "express";
import * as authController from "./../api/controllers/authController.js";
import { createSubscription } from "./../api/controllers/dodoPaymentsController.js";

const router = express.Router();

router.use(authController.protect);

router.post("/subscriptions", createSubscription);

export default router;
