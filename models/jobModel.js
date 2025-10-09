import mongoose from "mongoose";

const jobSchema = new mongoose.Schema(
  {
    // Core job identification
    jobId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    // User association
    userId: {
      type: mongoose.Schema.ObjectId,
      ref: "User",
      required: [true, "Job must belong to a user"],
      index: true,
    },

    // Job parameters
    jobParams: {
      keyword: {
        type: String,
        required: [true, "Keyword is required"],
      },
      city: {
        type: String,
        default: null,
      },
      stateCode: {
        type: String,
        default: null,
      },
      countryCode: {
        type: String,
        required: [true, "Country code is required"],
        uppercase: true,
      },
      maxRecords: {
        type: Number,
        default: 50,
        min: 1,
        max: 1000,
      },
      minRating: {
        type: Number,
        default: null,
        min: 0,
        max: 5,
      },
      ratingFilter: {
        operator: {
          type: String,
          enum: ["gt", "lt", "gte", "lte"],
          default: null,
        },
        value: {
          type: Number,
          min: 0,
          max: 5,
          default: null,
        },
      },
      reviewFilter: {
        operator: {
          type: String,
          enum: ["gt", "lt", "gte", "lte"],
          default: null,
        },
        value: {
          type: Number,
          min: 0,
          max: 10000,
          default: null,
        },
      },
      reviewTimeRange: {
        type: Number,
        default: null,
        min: 0,
        max: 10,
      },
    },

    // Job status and progress
    status: {
      type: String,
      enum: [
        "waiting",
        "active",
        "completed",
        "failed",
        "data_not_found",
        "delayed",
        "paused",
      ],
      default: "active",
      index: true,
    },

    progress: {
      percentage: {
        type: Number,
        default: 0,
        min: 0,
        max: 100,
      },
      details: {
        type: mongoose.Schema.Types.Mixed,
        default: {},
      },
    },

    // Job results and metrics
    result: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    // Error handling
    error: {
      message: String,
      stack: String,
      timestamp: Date,
    },

    metrics: {
      totalExtractions: {
        type: Number,
        default: 0,
      },
      dataPointsCollected: {
        type: Number,
        default: 0,
      },
      creditsUsed: {
        type: Number,
        default: 0,
      },
      estimatedCredits: {
        type: Number,
        default: 0,
      },
      creditsRefunded: {
        type: Number,
        default: 0,
      },
      planType: {
        type: String,
        default: null,
      },
    },

    // Timestamps
    createdAt: {
      type: Date,
      default: Date.now,
      index: true,
    },

    startedAt: {
      type: Date,
      default: null,
    },

    completedAt: {
      type: Date,
      default: null,
    },

    // Job queue specific
    queueName: {
      type: String,
      default: "scraper",
    },

    priority: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Indexes for better query performance
jobSchema.index({ userId: 1, createdAt: -1 });
jobSchema.index({ status: 1, createdAt: -1 });
jobSchema.index({ userId: 1, status: 1 });

// TTL Index for automatic cleanup based on user plan
// This is the most efficient approach - MongoDB handles cleanup automatically
jobSchema.index(
  {
    createdAt: 1,
    userId: 1,
  },
  {
    expireAfterSeconds: 0, // We'll set this dynamically
    partialFilterExpression: {
      // Only apply TTL to completed/failed jobs
      status: { $in: ["completed", "failed"] },
    },
  }
);

// Virtual for duration calculation (in milliseconds)
jobSchema.virtual("duration").get(function () {
  if (this.startedAt && this.completedAt) {
    return this.completedAt - this.startedAt;
  }
  return null;
});

// Virtual for human-readable duration
jobSchema.virtual("durationFormatted").get(function () {
  const duration = this.duration;
  if (!duration) return null;

  const seconds = Math.floor(duration / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
  } else if (minutes > 0) {
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  } else {
    return `${seconds}s`;
  }
});

// Virtual for duration in seconds (useful for API responses)
jobSchema.virtual("durationSeconds").get(function () {
  const duration = this.duration;
  return duration ? Math.floor(duration / 1000) : null;
});

// Instance method to update job status
jobSchema.methods.updateStatus = async function (status, additionalData = {}) {
  this.status = status;

  if (status === "active" && !this.startedAt) {
    this.startedAt = new Date();
  } else if (["completed", "failed"].includes(status) && !this.completedAt) {
    this.completedAt = new Date();
  }

  Object.assign(this, additionalData);
  return await this.save();
};

// Static method to clean up old jobs using batch processing
jobSchema.statics.cleanupOldJobs = async function (batchSize = 100) {
  const User = mongoose.model("User");

  const cleanupResults = {
    freePlanDeleted: 0,
    otherPlanDeleted: 0,
    totalBatches: 0,
    errors: [],
  };

  try {
    // Calculate cutoff dates
    const freePlanCutoff = new Date();
    freePlanCutoff.setHours(freePlanCutoff.getHours() - 24);

    const otherPlanCutoff = new Date();
    otherPlanCutoff.setDate(otherPlanCutoff.getDate() - 30);

    // Process free plan users in batches
    let freePlanSkip = 0;
    let hasMoreFreeUsers = true;

    while (hasMoreFreeUsers) {
      const freeUsers = await User.find({ plan: "free" }, "_id plan")
        .skip(freePlanSkip)
        .limit(batchSize);

      if (freeUsers.length === 0) {
        hasMoreFreeUsers = false;
        break;
      }

      const freeUserIds = freeUsers.map((user) => user._id);

      const freeResult = await this.deleteMany({
        userId: { $in: freeUserIds },
        createdAt: { $lt: freePlanCutoff },
      });

      cleanupResults.freePlanDeleted += freeResult.deletedCount;
      cleanupResults.totalBatches++;
      freePlanSkip += batchSize;

      // If we got less than batchSize, we're done
      if (freeUsers.length < batchSize) {
        hasMoreFreeUsers = false;
      }
    }

    // Process other plan users in batches
    let otherPlanSkip = 0;
    let hasMoreOtherUsers = true;

    while (hasMoreOtherUsers) {
      const otherUsers = await User.find({ plan: { $ne: "free" } }, "_id plan")
        .skip(otherPlanSkip)
        .limit(batchSize);

      if (otherUsers.length === 0) {
        hasMoreOtherUsers = false;
        break;
      }

      const otherUserIds = otherUsers.map((user) => user._id);

      const otherResult = await this.deleteMany({
        userId: { $in: otherUserIds },
        createdAt: { $lt: otherPlanCutoff },
      });

      cleanupResults.otherPlanDeleted += otherResult.deletedCount;
      cleanupResults.totalBatches++;
      otherPlanSkip += batchSize;

      // If we got less than batchSize, we're done
      if (otherUsers.length < batchSize) {
        hasMoreOtherUsers = false;
      }
    }
  } catch (error) {
    cleanupResults.errors.push({
      error: error.message,
      stack: error.stack,
    });
  }

  return cleanupResults;
};

// Static method to get user extraction statistics
jobSchema.statics.getUserStats = async function (userId, timeframe = 30) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - timeframe);

  const currentStats = await this.aggregate([
    {
      $match: {
        userId: new mongoose.Types.ObjectId(userId),
        createdAt: { $gte: startDate },
      },
    },
    {
      $group: {
        _id: null,
        totalExtractions: { $sum: "$metrics.totalExtractions" },
        totalDataPoints: { $sum: "$metrics.dataPointsCollected" },
        activeJobs: {
          $sum: {
            $cond: [
              { $in: ["$status", ["waiting", "active", "delayed"]] },
              1,
              0,
            ],
          },
        },
        totalCreditsUsed: { $sum: "$metrics.creditsUsed" },
        completedJobs: {
          $sum: {
            $cond: [{ $eq: ["$status", "completed"] }, 1, 0],
          },
        },
        totalJobs: { $sum: 1 },
      },
    },
  ]);

  // Get previous period stats for comparison
  const previousStartDate = new Date(startDate);
  previousStartDate.setDate(previousStartDate.getDate() - timeframe);

  const previousStats = await this.aggregate([
    {
      $match: {
        userId: new mongoose.Types.ObjectId(userId),
        createdAt: { $gte: previousStartDate, $lt: startDate },
      },
    },
    {
      $group: {
        _id: null,
        totalExtractions: { $sum: "$metrics.totalExtractions" },
        totalDataPoints: { $sum: "$metrics.dataPointsCollected" },
      },
    },
  ]);

  const current = currentStats[0] || {
    totalExtractions: 0,
    totalDataPoints: 0,
    activeJobs: 0,
    totalCreditsUsed: 0,
    completedJobs: 0,
    totalJobs: 0,
  };
  const previous = previousStats[0] || {
    totalExtractions: 0,
    totalDataPoints: 0,
  };

  // Calculate percentage changes
  const extractionChange =
    previous.totalExtractions > 0
      ? (
          ((current.totalExtractions - previous.totalExtractions) /
            previous.totalExtractions) *
          100
        ).toFixed(1)
      : current.totalExtractions > 0
      ? 100
      : 0;

  const dataPointChange =
    previous.totalDataPoints > 0
      ? (
          ((current.totalDataPoints - previous.totalDataPoints) /
            previous.totalDataPoints) *
          100
        ).toFixed(1)
      : current.totalDataPoints > 0
      ? 100
      : 0;

  return {
    totalExtractions: {
      value: current.totalExtractions,
      change: `${extractionChange > 0 ? "+" : ""}${extractionChange}%`,
    },
    dataPointsCollected: {
      value: current.totalDataPoints,
      change: `${dataPointChange > 0 ? "+" : ""}${dataPointChange}%`,
    },
    activeJobs: {
      value: current.activeJobs,
    },
    totalCreditsUsed: {
      value: current.totalCreditsUsed,
    },
    completedJobs: {
      value: current.completedJobs,
    },
    totalJobs: {
      value: current.totalJobs,
    },
    successRate: {
      value:
        current.totalJobs > 0
          ? ((current.completedJobs / current.totalJobs) * 100).toFixed(1)
          : 0,
    },
  };
};

const Job = mongoose.model("Job", jobSchema);
export default Job;
