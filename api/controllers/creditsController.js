import catchAsync from "../../utils/catchAsync.js";
import AppError from "../../utils/appError.js";
import creditsService from "../../services/credits.service.js";
import creditsJob from "../../jobs/creditsJob.js";

/**
 * Get user's credit status
 * GET /api/v1/credits/status
 */
export const getCreditStatus = catchAsync(async (req, res, next) => {
  const userId = req.user._id;

  const creditStatus = await creditsService.getUserCreditStatus(userId);

  res.status(200).json({
    status: "success",
    data: {
      credits: creditStatus,
    },
  });
});

/**
 * Check if user has sufficient credits for an operation
 * POST /api/v1/credits/check
 * Body: { requiredCredits: number }
 */
export const checkCredits = catchAsync(async (req, res, next) => {
  const { requiredCredits } = req.body;
  const userId = req.user._id;

  if (!requiredCredits || requiredCredits <= 0) {
    return next(new AppError("Valid required credits amount is required", 400));
  }

  const creditCheck = await creditsService.checkCredits(
    userId,
    requiredCredits
  );

  res.status(200).json({
    status: "success",
    data: {
      creditCheck,
    },
  });
});

/**
 * Manually allocate credits to user (admin only)
 * POST /api/v1/credits/allocate
 * Body: { userId: string, reason?: string }
 */
export const allocateCredits = catchAsync(async (req, res, next) => {
  const { userId, reason = "manual" } = req.body;

  if (!userId) {
    return next(new AppError("User ID is required", 400));
  }

  // Check if user is admin
  if (req.user.role !== "admin") {
    return next(new AppError("Only admins can manually allocate credits", 403));
  }

  const updatedUser = await creditsService.allocateCredits(userId, reason);

  res.status(200).json({
    status: "success",
    message: "Credits allocated successfully",
    data: {
      user: {
        id: updatedUser._id,
        plan: updatedUser.plan,
        credits: updatedUser.credits,
      },
    },
  });
});

/**
 * Trigger monthly credits allocation (admin only)
 * POST /api/v1/credits/trigger-monthly
 */
export const triggerMonthlyAllocation = catchAsync(async (req, res, next) => {
  // Check if user is admin
  if (req.user.role !== "admin") {
    return next(
      new AppError("Only admins can trigger monthly allocation", 403)
    );
  }

  const results = await creditsJob.triggerMonthlyAllocation();

  res.status(200).json({
    status: "success",
    message: "Monthly credits allocation triggered",
    data: {
      results,
    },
  });
});

/**
 * Trigger monthly reset (admin only)
 * POST /api/v1/credits/trigger-reset
 */
export const triggerMonthlyReset = catchAsync(async (req, res, next) => {
  // Check if user is admin
  if (req.user.role !== "admin") {
    return next(new AppError("Only admins can trigger monthly reset", 403));
  }

  const results = await creditsJob.triggerMonthlyReset();

  res.status(200).json({
    status: "success",
    message: "Monthly reset triggered",
    data: {
      results,
    },
  });
});

/**
 * Get job status (admin only)
 * GET /api/v1/credits/job-status
 */
export const getJobStatus = catchAsync(async (req, res, next) => {
  // Check if user is admin
  if (req.user.role !== "admin") {
    return next(new AppError("Only admins can view job status", 403));
  }

  const jobStatus = creditsJob.getJobStatus();

  res.status(200).json({
    status: "success",
    data: {
      jobs: jobStatus,
    },
  });
});

/**
 * Get credit allocation amounts for all plans
 * GET /api/v1/credits/allocation-info
 */
export const getCreditAllocationInfo = catchAsync(async (req, res, next) => {
  const allocationInfo = {
    free: creditsService.getCreditAllocation("free"),
    pro: creditsService.getCreditAllocation("pro"),
    business: creditsService.getCreditAllocation("business"),
  };

  res.status(200).json({
    status: "success",
    data: {
      allocations: allocationInfo,
    },
  });
});

/**
 * Get user's credit history (if you want to implement this later)
 * GET /api/v1/credits/history
 */
export const getCreditHistory = catchAsync(async (req, res, next) => {
  // This would require a separate credits history model
  // For now, return a placeholder response
  res.status(200).json({
    status: "success",
    message: "Credit history feature not yet implemented",
    data: {
      history: [],
    },
  });
});

/**
 * Downgrade user to free plan (admin only)
 * POST /api/v1/credits/downgrade
 * Body: { userId: string, reason?: string }
 */
export const downgradeUser = catchAsync(async (req, res, next) => {
  const { userId, reason = "manual_downgrade" } = req.body;

  if (!userId) {
    return next(new AppError("User ID is required", 400));
  }

  // Check if user is admin
  if (req.user.role !== "admin") {
    return next(new AppError("Only admins can downgrade users", 403));
  }

  const updatedUser = await creditsService.downgradeToFreePlan(userId, reason);

  res.status(200).json({
    status: "success",
    message: "User downgraded to free plan successfully",
    data: {
      user: {
        id: updatedUser._id,
        plan: updatedUser.plan,
        credits: updatedUser.credits,
      },
    },
  });
});

/**
 * Handle subscription status change (admin only)
 * POST /api/v1/credits/subscription-status
 * Body: { userId: string, status: string, reason?: string }
 */
export const updateSubscriptionStatus = catchAsync(async (req, res, next) => {
  const { userId, status, reason = "manual_status_change" } = req.body;

  if (!userId || !status) {
    return next(new AppError("User ID and status are required", 400));
  }

  // Check if user is admin
  if (req.user.role !== "admin") {
    return next(
      new AppError("Only admins can update subscription status", 403)
    );
  }

  const updatedUser = await creditsService.handleSubscriptionStatusChange(
    userId,
    status,
    reason
  );

  res.status(200).json({
    status: "success",
    message: "Subscription status updated successfully",
    data: {
      user: {
        id: updatedUser._id,
        plan: updatedUser.plan,
        credits: updatedUser.credits,
        subscription: updatedUser.subscription,
      },
    },
  });
});
