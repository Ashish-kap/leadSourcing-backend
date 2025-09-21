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
    return next(new AppError("Unable to determine Dodo customer for user", 500));
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

export default {
  createSubscription,
};
