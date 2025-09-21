import express from "express";
import { Webhook } from "standardwebhooks";
import logger from "../services/logger.js";
import User from "../models/userModel.js";

const router = express.Router();

// Initialize webhook with secret key from environment
// The secret should be base64 encoded, if not, encode it
const getWebhookSecret = () => {
  const secret = process.env.DODO_PAYMENTS_WEBHOOK_SECRET || "DODOS_DONT_FLY";
  // Check if it's already base64 encoded
  try {
    Buffer.from(secret, "base64").toString("base64") === secret;
    return secret;
  } catch {
    // If not base64, encode it
    return Buffer.from(secret).toString("base64");
  }
};

const webhook = new Webhook(getWebhookSecret());

// Product ID to Plan mapping
const PRODUCT_PLAN_MAPPING = {
  [process.env.DODO_PRODUCT_ID_PLAN_BUSINESS]: "business",
  // Add more product IDs and their corresponding plans here
  // [process.env.DODO_PRODUCT_ID_PLAN_PRO]: "pro",
  // [process.env.DODO_PRODUCT_ID_PLAN_PREMIUM]: "premium",
};

// Webhook endpoint for Dodo Payments
router.post("/webhook", async (req, res) => {
  try {
    const body = req.body;

    // Extract webhook headers
    const webhookHeaders = {
      "webhook-id": req.headers["webhook-id"] || "",
      "webhook-signature": req.headers["webhook-signature"] || "",
      "webhook-timestamp": req.headers["webhook-timestamp"] || "",
    };

    // Debug logging
    // console.log("=== WEBHOOK DEBUG ===");
    // console.log("Headers received:", {
    //   "webhook-id": webhookHeaders["webhook-id"],
    //   "webhook-signature": webhookHeaders["webhook-signature"]
    //     ? "Present"
    //     : "Missing",
    //   "webhook-timestamp": webhookHeaders["webhook-timestamp"],
    // });
    // console.log("Body received:", JSON.stringify(body, null, 2));
    // console.log(
    //   "Webhook secret configured:",
    //   process.env.DODO_PAYMENTS_WEBHOOK_SECRET ? "Yes" : "No"
    // );

    // Convert body to string for verification
    const raw = JSON.stringify(body);
    // console.log("Raw body for verification:", raw);

    // Verify webhook signature
    let verificationResult = null;
    try {
      verificationResult = webhook.verify(raw, webhookHeaders);
      //   console.log("Signature verification result:", verificationResult);
    } catch (verifyError) {
      //   console.log("Signature verification error:", verifyError.message);
      logger.error("WEBHOOK_VERIFICATION_FAILED", {
        headers: webhookHeaders,
        body: body,
        secret_configured: !!process.env.DODO_PAYMENTS_WEBHOOK_SECRET,
        error: verifyError.message,
      });
      return res.status(401).json({ error: "Invalid webhook signature" });
    }

    if (!verificationResult) {
      logger.error("WEBHOOK_VERIFICATION_FAILED", {
        headers: webhookHeaders,
        body: body,
        secret_configured: !!process.env.DODO_PAYMENTS_WEBHOOK_SECRET,
      });
      return res.status(401).json({ error: "Invalid webhook signature" });
    }

    // Log the received webhook
    logger.info("WEBHOOK_RECEIVED", {
      type: body.type,
      business_id: body.business_id,
      timestamp: body.timestamp,
      payload_type: body.data?.payload_type,
    });

    // Handle different webhook event types
    switch (body.type) {
      case "subscription.active":
        await handleSubscriptionActive(body);
        break;
      case "subscription.cancelled":
        await handleSubscriptionCancelled(body);
        break;
      case "subscription.expired":
        await handleSubscriptionExpired(body);
        break;
      case "payment.succeeded":
        await handlePaymentSucceeded(body);
        break;
      case "payment.failed":
        await handlePaymentFailed(body);
        break;
      default:
        logger.info("WEBHOOK_UNHANDLED_EVENT", { type: body.type });
    }

    // Return success response
    res.status(200).json({ received: true, processed: true });
  } catch (error) {
    logger.error("WEBHOOK_PROCESSING_ERROR", {
      error: error.message,
      stack: error.stack,
    });
    res.status(400).json({ error: "Webhook handler failed" });
  }
});

// Handle subscription.active event
async function handleSubscriptionActive(webhookData) {
  try {
    const customerId = webhookData.data?.customer?.customer_id;
    const businessId = webhookData.business_id;
    const subscriptionId = webhookData.data?.subscription_id;
    const productId = webhookData.data?.product_id;
    const status = webhookData.data?.status;

    logger.info("SUBSCRIPTION_ACTIVE", {
      business_id: businessId,
      subscription_id: subscriptionId,
      customer_id: customerId,
      product_id: productId,
      status: status,
    });

    if (!customerId) {
      logger.error("SUBSCRIPTION_ACTIVE_MISSING_CUSTOMER_ID", {
        webhookData: webhookData,
      });
      throw new Error("Customer ID not found in webhook data");
    }

    if (!productId) {
      logger.error("SUBSCRIPTION_ACTIVE_MISSING_PRODUCT_ID", {
        webhookData: webhookData,
      });
      throw new Error("Product ID not found in webhook data");
    }

    // Find user by customer ID
    const user = await User.findOne({ dodoCustomerId: customerId });

    if (!user) {
      logger.error("SUBSCRIPTION_ACTIVE_USER_NOT_FOUND", {
        customerId: customerId,
        businessId: businessId,
      });
      throw new Error(`User not found for customer ID: ${customerId}`);
    }

    // Get plan based on product ID
    const newPlan = PRODUCT_PLAN_MAPPING[productId];

    if (!newPlan) {
      logger.error("SUBSCRIPTION_ACTIVE_UNKNOWN_PRODUCT_ID", {
        productId: productId,
        availableMappings: Object.keys(PRODUCT_PLAN_MAPPING),
      });
      throw new Error(
        `Unknown product ID: ${productId}. No plan mapping found.`
      );
    }

    // Update user plan based on product ID
    user.plan = newPlan;

    // Update business ID if not already set
    if (!user.dodoBusinessId) {
      user.dodoBusinessId = businessId;
    }

    // Save user with updated plan
    await user.save({ validateBeforeSave: false });

    logger.info("USER_PLAN_UPDATED", {
      userId: user._id,
      customerId: customerId,
      businessId: businessId,
      productId: productId,
      newPlan: newPlan,
      subscriptionId: subscriptionId,
    });

    console.log(
      `✅ User ${user._id} plan updated to ${newPlan} for product ${productId} (subscription: ${subscriptionId})`
    );
  } catch (error) {
    logger.error("SUBSCRIPTION_ACTIVE_ERROR", {
      error: error.message,
      business_id: webhookData.business_id,
      customer_id: webhookData.data?.customer?.customer_id,
      product_id: webhookData.data?.product_id,
    });
    throw error;
  }
}

// Handle subscription.cancelled event
async function handleSubscriptionCancelled(webhookData) {
  try {
    const customerId = webhookData.data?.customer?.customer_id;
    const businessId = webhookData.business_id;
    const subscriptionId = webhookData.data?.subscription_id;
    const cancellationReason = webhookData.data?.cancellation_reason;

    logger.info("SUBSCRIPTION_CANCELLED", {
      business_id: businessId,
      subscription_id: subscriptionId,
      customer_id: customerId,
      cancellation_reason: cancellationReason,
    });

    if (!customerId) {
      logger.error("SUBSCRIPTION_CANCELLED_MISSING_CUSTOMER_ID", {
        webhookData: webhookData,
      });
      throw new Error("Customer ID not found in webhook data");
    }

    // Find user by customer ID
    const user = await User.findOne({ dodoCustomerId: customerId });

    if (!user) {
      logger.error("SUBSCRIPTION_CANCELLED_USER_NOT_FOUND", {
        customerId: customerId,
        businessId: businessId,
      });
      throw new Error(`User not found for customer ID: ${customerId}`);
    }

    // Get the original plan from product ID before downgrading
    const productId = webhookData.data?.product_id;
    const originalPlan = productId ? PRODUCT_PLAN_MAPPING[productId] : null;

    // Downgrade user plan to free
    user.plan = "free";

    // Save user with updated plan
    await user.save({ validateBeforeSave: false });

    logger.info("USER_PLAN_DOWNGRADED", {
      userId: user._id,
      customerId: customerId,
      businessId: businessId,
      productId: productId,
      originalPlan: originalPlan,
      newPlan: "free",
      subscriptionId: subscriptionId,
      cancellationReason: cancellationReason,
    });

    console.log(
      `⚠️ User ${user._id} plan downgraded to free due to subscription cancellation: ${subscriptionId}`
    );
  } catch (error) {
    logger.error("SUBSCRIPTION_CANCELLED_ERROR", {
      error: error.message,
      business_id: webhookData.business_id,
      customer_id: webhookData.data?.customer?.customer_id,
    });
    throw error;
  }
}

// Handle subscription.expired event
async function handleSubscriptionExpired(webhookData) {
  try {
    const customerId = webhookData.data?.customer?.customer_id;
    const businessId = webhookData.business_id;
    const subscriptionId = webhookData.data?.subscription_id;
    const expiredAt = webhookData.data?.expired_at;

    logger.info("SUBSCRIPTION_EXPIRED", {
      business_id: businessId,
      subscription_id: subscriptionId,
      customer_id: customerId,
      expired_at: expiredAt,
    });

    if (!customerId) {
      logger.error("SUBSCRIPTION_EXPIRED_MISSING_CUSTOMER_ID", {
        webhookData: webhookData,
      });
      throw new Error("Customer ID not found in webhook data");
    }

    // Find user by customer ID
    const user = await User.findOne({ dodoCustomerId: customerId });

    if (!user) {
      logger.error("SUBSCRIPTION_EXPIRED_USER_NOT_FOUND", {
        customerId: customerId,
        businessId: businessId,
      });
      throw new Error(`User not found for customer ID: ${customerId}`);
    }

    // Get the original plan from product ID before downgrading
    const productId = webhookData.data?.product_id;
    const originalPlan = productId ? PRODUCT_PLAN_MAPPING[productId] : null;

    // Downgrade user plan to free
    user.plan = "free";

    // Save user with updated plan
    await user.save({ validateBeforeSave: false });

    logger.info("USER_PLAN_EXPIRED", {
      userId: user._id,
      customerId: customerId,
      businessId: businessId,
      productId: productId,
      originalPlan: originalPlan,
      newPlan: "free",
      subscriptionId: subscriptionId,
      expiredAt: expiredAt,
    });

    console.log(
      `⏰ User ${user._id} plan downgraded to free due to subscription expiration: ${subscriptionId}`
    );
  } catch (error) {
    logger.error("SUBSCRIPTION_EXPIRED_ERROR", {
      error: error.message,
      business_id: webhookData.business_id,
      customer_id: webhookData.data?.customer?.customer_id,
    });
    throw error;
  }
}

// Handle payment.succeeded event
async function handlePaymentSucceeded(webhookData) {
  try {
    logger.info("PAYMENT_SUCCEEDED", {
      business_id: webhookData.business_id,
      payment_id: webhookData.data?.id,
      amount: webhookData.data?.amount,
      currency: webhookData.data?.currency,
      customer_id: webhookData.data?.customer_id,
    });

    // TODO: Implement your business logic here
    // Examples:
    // - Update payment records in database
    // - Send payment confirmation email
    // - Update subscription status
    // - Process order fulfillment

    console.log("Payment succeeded for business:", webhookData.business_id);
  } catch (error) {
    logger.error("PAYMENT_SUCCEEDED_ERROR", {
      error: error.message,
      business_id: webhookData.business_id,
    });
    throw error;
  }
}

// Handle payment.failed event
async function handlePaymentFailed(webhookData) {
  try {
    logger.info("PAYMENT_FAILED", {
      business_id: webhookData.business_id,
      payment_id: webhookData.data?.id,
      amount: webhookData.data?.amount,
      currency: webhookData.data?.currency,
      failure_reason: webhookData.data?.failure_reason,
      customer_id: webhookData.data?.customer_id,
    });

    // TODO: Implement your business logic here
    // Examples:
    // - Update payment records in database
    // - Send payment failure notification
    // - Update subscription status
    // - Retry payment or suspend service

    console.log("Payment failed for business:", webhookData.business_id);
  } catch (error) {
    logger.error("PAYMENT_FAILED_ERROR", {
      error: error.message,
      business_id: webhookData.business_id,
    });
    throw error;
  }
}

export default router;
