import Feedback from "../../models/feedbackModel.js";
import catchAsync from "../../utils/catchAsync.js";
import AppError from "../../utils/appError.js";

// Create feedback
export const createFeedback = catchAsync(async (req, res, next) => {
  // Get user ID from authenticated user
  const userId = req.user.id;

  // Create feedback
  const feedback = await Feedback.create({
    userId,
    message: req.body.message,
    isSatisfied: req.body.isSatisfied,
  });

  // Populate user information
  await feedback.populate({
    path: "user",
    select: "name emailID plan", // Only include safe user fields
  });

  res.status(201).json({
    status: "success",
    data: {
      feedback,
    },
  });
});

// Get all feedback (for admin use)
export const getAllFeedback = catchAsync(async (req, res, next) => {
  const feedback = await Feedback.find()
    .populate({
      path: "user",
      select: "name emailID plan",
    })
    .sort({ createdAt: -1 });

  res.status(200).json({
    status: "success",
    results: feedback.length,
    data: {
      feedback,
    },
  });
});

// Get user's own feedback
export const getMyFeedback = catchAsync(async (req, res, next) => {
  const feedback = await Feedback.find({ userId: req.user.id })
    .populate({
      path: "user",
      select: "name emailID plan",
    })
    .sort({ createdAt: -1 });

  res.status(200).json({
    status: "success",
    results: feedback.length,
    data: {
      feedback,
    },
  });
});

// Get single feedback by ID
export const getFeedback = catchAsync(async (req, res, next) => {
  const feedback = await Feedback.findById(req.params.id).populate({
    path: "user",
    select: "name emailID plan",
  });

  if (!feedback) {
    return next(new AppError("No feedback found with that ID", 404));
  }

  res.status(200).json({
    status: "success",
    data: {
      feedback,
    },
  });
});

// Delete feedback (user can only delete their own)
export const deleteFeedback = catchAsync(async (req, res, next) => {
  const feedback = await Feedback.findById(req.params.id);

  if (!feedback) {
    return next(new AppError("No feedback found with that ID", 404));
  }

  // Check if user owns this feedback or is admin
  if (feedback.userId.toString() !== req.user.id && req.user.role !== "admin") {
    return next(new AppError("You can only delete your own feedback", 403));
  }

  await Feedback.findByIdAndDelete(req.params.id);

  res.status(204).json({
    status: "success",
    data: null,
  });
});

// Get satisfaction analytics (for admin use)
export const getSatisfactionAnalytics = catchAsync(async (req, res, next) => {
  const analytics = await Feedback.aggregate([
    {
      $group: {
        _id: null,
        totalFeedback: { $sum: 1 },
        satisfiedCount: {
          $sum: { $cond: ["$isSatisfied", 1, 0] },
        },
        unsatisfiedCount: {
          $sum: { $cond: ["$isSatisfied", 0, 1] },
        },
        satisfactionRate: {
          $avg: { $cond: ["$isSatisfied", 1, 0] },
        },
      },
    },
    {
      $project: {
        _id: 0,
        totalFeedback: 1,
        satisfiedCount: 1,
        unsatisfiedCount: 1,
        satisfactionRate: { $round: ["$satisfactionRate", 2] },
      },
    },
  ]);

  res.status(200).json({
    status: "success",
    data: {
      analytics: analytics[0] || {
        totalFeedback: 0,
        satisfiedCount: 0,
        unsatisfiedCount: 0,
        satisfactionRate: 0,
      },
    },
  });
});
