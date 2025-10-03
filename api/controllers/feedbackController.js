import Feedback from "../../models/feedbackModel.js";
import catchAsync from "../../utils/catchAsync.js";
import AppError from "../../utils/appError.js";

// Create feedback
export const createFeedback = catchAsync(async (req, res, next) => {
  // Validate required fields
  const { message, isSatisfied } = req.body;

  if (!message || message.trim().length === 0) {
    return next(new AppError("Message is required and cannot be empty", 400));
  }

  if (typeof isSatisfied !== "boolean") {
    return next(
      new AppError("isSatisfied must be a boolean value (true/false)", 400)
    );
  }

  // Get user ID from authenticated user
  const userId = req.user.id;

  try {
    // Create feedback
    const feedback = await Feedback.create({
      userId,
      message: message.trim(),
      isSatisfied,
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
  } catch (error) {
    // Handle validation errors from Mongoose
    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map((err) => err.message);
      return next(new AppError(`Validation failed: ${errors.join(", ")}`, 400));
    }

    // Handle duplicate key errors
    if (error.code === 11000) {
      return next(new AppError("Feedback already exists for this user", 409));
    }

    // Handle other database errors
    return next(new AppError("Failed to create feedback", 500));
  }
});

// Get all feedback (for admin use)
export const getAllFeedback = catchAsync(async (req, res, next) => {
  try {
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
  } catch (error) {
    return next(new AppError("Failed to retrieve feedback", 500));
  }
});

// Get user's own feedback
export const getMyFeedback = catchAsync(async (req, res, next) => {
  try {
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
  } catch (error) {
    return next(new AppError("Failed to retrieve your feedback", 500));
  }
});

// Get single feedback by ID
export const getFeedback = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  if (!id) {
    return next(new AppError("Feedback ID is required", 400));
  }

  try {
    const feedback = await Feedback.findById(id).populate({
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
  } catch (error) {
    if (error.name === "CastError") {
      return next(new AppError("Invalid feedback ID format", 400));
    }
    return next(new AppError("Failed to retrieve feedback", 500));
  }
});

// Delete feedback (user can only delete their own)
export const deleteFeedback = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  if (!id) {
    return next(new AppError("Feedback ID is required", 400));
  }

  try {
    const feedback = await Feedback.findById(id);

    if (!feedback) {
      return next(new AppError("No feedback found with that ID", 404));
    }

    // Check if user owns this feedback or is admin
    if (
      feedback.userId.toString() !== req.user.id &&
      req.user.role !== "admin"
    ) {
      return next(new AppError("You can only delete your own feedback", 403));
    }

    await Feedback.findByIdAndDelete(id);

    res.status(204).json({
      status: "success",
      data: null,
    });
  } catch (error) {
    if (error.name === "CastError") {
      return next(new AppError("Invalid feedback ID format", 400));
    }
    return next(new AppError("Failed to delete feedback", 500));
  }
});

// Get satisfaction analytics (for admin use)
export const getSatisfactionAnalytics = catchAsync(async (req, res, next) => {
  try {
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
  } catch (error) {
    return next(new AppError("Failed to retrieve satisfaction analytics", 500));
  }
});
