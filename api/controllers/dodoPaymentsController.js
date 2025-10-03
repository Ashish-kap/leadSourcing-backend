import catchAsync from "./../../utils/catchAsync.js";
import AppError from "./../../utils/appError.js";
import getDodoClient from "./../../services/dodoPaymentsClient.js";
import { ensureDodoCustomerForUser } from "./../../services/dodoPayments.service.js";

export const createSubscription = catchAsync(async (req, res, next) => {
  const payload = { ...req.body };

  const missingFields = ["billing", "product_id", "return_url"].filter(
    (field) => payload[field] === undefined || payload[field] === null
  );

  if (missingFields.length > 0) {
    const message = `Missing required field(s): ${missingFields.join(", ")}`;
    return next(new AppError(message, 400));
  }

  if (payload.payment_link === undefined) {
    payload.payment_link = true;
  }

  if (payload.quantity === undefined) {
    payload.quantity = 1;
  }

  let client;
  try {
    client = getDodoClient();
  } catch (error) {
    return next(new AppError(error.message, 500));
  }

  let userWithCustomer;
  try {
    userWithCustomer = await ensureDodoCustomerForUser(req.user);
  } catch (error) {
    return next(
      new AppError(error.message || "Failed to create Dodo customer", 500)
    );
  }

  if (!userWithCustomer?.dodoCustomerId) {
    return next(
      new AppError("Unable to determine Dodo customer for user", 500)
    );
  }

  payload.customer = {
    customer_id: userWithCustomer.dodoCustomerId,
  };

  const subscription = await client.subscriptions.create(payload);

  res.status(201).json({
    status: "success",
    data: {
      subscription,
    },
  });
});

export const cancelSubscription = catchAsync(async (req, res, next) => {
  const { subscriptionId } = req.params;

  if (!subscriptionId) {
    return next(new AppError("Subscription ID is required", 400));
  }

  let client;
  try {
    client = getDodoClient();
  } catch (error) {
    return next(new AppError(error.message, 500));
  }

  // Build the update payload for cancellation
  const updatePayload = {
    status: "cancelled",
  };

  // Add optional fields from request body if provided
  if (req.body && req.body.cancel_at_next_billing_date !== undefined) {
    updatePayload.cancel_at_next_billing_date =
      req.body.cancel_at_next_billing_date;
  } else {
    updatePayload.cancel_at_next_billing_date = null;
  }

  if (req.body && req.body.metadata) {
    updatePayload.metadata = req.body.metadata;
  }

  if (req.body && req.body.next_billing_date) {
    updatePayload.next_billing_date = req.body.next_billing_date;
  }

  if (req.body && req.body.billing) {
    updatePayload.billing = req.body.billing;
  }

  if (req.body && req.body.disable_on_demand) {
    updatePayload.disable_on_demand = req.body.disable_on_demand;
  }

  if (req.body && req.body.tax_id) {
    updatePayload.tax_id = req.body.tax_id;
  }

  try {
    const updatedSubscription = await client.subscriptions.update(
      subscriptionId,
      updatePayload
    );

    res.status(200).json({
      status: "success",
      data: {
        subscription: updatedSubscription,
      },
    });
  } catch (error) {
    const statusCode = error?.statusCode || error?.response?.status;
    const errorBody =
      error?.response?.data || error?.body || error?.message || error;

    let errorMessage = "Failed to cancel subscription";
    if (statusCode) {
      errorMessage += `: status ${statusCode}`;
    }
    if (errorBody && typeof errorBody !== "string") {
      try {
        errorMessage += ` ${JSON.stringify(errorBody)}`;
      } catch (_) {
        // ignore JSON stringify errors
      }
    } else if (errorBody) {
      errorMessage += ` ${errorBody}`;
    }

    return next(new AppError(errorMessage.trim(), statusCode || 500));
  }
});

export default {
  createSubscription,
  cancelSubscription,
};
