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
        default: 0,
        min: 0,
        max: 5,
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
      enum: ["waiting", "active", "completed", "failed", "delayed", "paused"],
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

// Virtual for duration calculation
jobSchema.virtual("duration").get(function () {
  if (this.startedAt && this.completedAt) {
    return this.completedAt - this.startedAt;
  }
  return null;
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
