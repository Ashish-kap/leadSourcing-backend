import catchAsync from "./../../utils/catchAsync.js";
import AppError from "./../../utils/appError.js";
import getDodoClient from "./../../services/dodoPaymentsClient.js";

export const createSubscription = catchAsync(async (req, res, next) => {
  const payload = { ...req.body };

  const missingFields = ["billing", "customer", "product_id", "return_url"].filter(
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
