import scraperQueue from "../../services/queue.js";
import Job from "./../../models/jobModel.js";
import User from "./../../models/userModel.js";
import { v4 as uuidv4 } from "uuid";

const scrapeData = async (req, res) => {
  try {
    const {
      keyword,
      city = null,
      countryCode,
      stateCode = null,
      maxRecords = 50,
      ratingFilter = null,
      reviewFilter = null,
      reviewTimeRange = null,
      isExtractEmail = false,
    } = req.body;

    // Get user from auth middleware (assuming you have auth middleware)
    console.log(req.user);
    const userId = req.user.id;

    // Validate mandatory fields
    if (!keyword) {
      return res.status(400).json({
        error: "keyword is required",
      });
    }

    if (!countryCode) {
      return res.status(400).json({
        error: "countryCode is required",
      });
    }

    // Validate numeric parameters
    if (maxRecords && (isNaN(maxRecords) || maxRecords < 1)) {
      return res.status(400).json({
        error: "maxRecords must be a positive number",
      });
    }

    if (ratingFilter) {
      if (
        !ratingFilter.operator ||
        !["gt", "lt", "gte", "lte"].includes(ratingFilter.operator)
      ) {
        return res.status(400).json({
          error: "ratingFilter.operator must be one of: gt, lt, gte, lte",
        });
      }
      if (
        ratingFilter.value === undefined ||
        isNaN(ratingFilter.value) ||
        ratingFilter.value < 0 ||
        ratingFilter.value > 5
      ) {
        return res.status(400).json({
          error: "ratingFilter.value must be a number between 0 and 5",
        });
      }

      // Warn about potentially restrictive filters
      const isRestrictiveFilter =
        (ratingFilter.operator === "lte" && ratingFilter.value <= 3) ||
        (ratingFilter.operator === "lt" && ratingFilter.value <= 3.5) ||
        (ratingFilter.operator === "gte" && ratingFilter.value >= 4.8) ||
        (ratingFilter.operator === "gt" && ratingFilter.value >= 4.5);

      if (isRestrictiveFilter) {
        console.warn(
          "RESTRICTIVE_FILTER_WARNING",
          "User applied potentially restrictive rating filter",
          {
            ratingFilter,
            userId,
            keyword,
            warning:
              "This filter may result in very few results or early termination",
          }
        );
      }
    }

    if (reviewFilter) {
      if (
        !reviewFilter.operator ||
        !["gt", "lt", "gte", "lte"].includes(reviewFilter.operator)
      ) {
        return res.status(400).json({
          error: "reviewFilter.operator must be one of: gt, lt, gte, lte",
        });
      }
      if (
        reviewFilter.value === undefined ||
        isNaN(reviewFilter.value) ||
        reviewFilter.value < 0 ||
        reviewFilter.value > 10000
      ) {
        return res.status(400).json({
          error: "reviewFilter.value must be a number between 0 and 10,000",
        });
      }

      // Warn about potentially restrictive filters
      const isRestrictiveFilter =
        (reviewFilter.operator === "lte" && reviewFilter.value <= 5) ||
        (reviewFilter.operator === "lt" && reviewFilter.value <= 3) ||
        (reviewFilter.operator === "gte" && reviewFilter.value >= 1000) ||
        (reviewFilter.operator === "gt" && reviewFilter.value >= 500);

      if (isRestrictiveFilter) {
        console.warn(
          "RESTRICTIVE_REVIEW_FILTER_WARNING",
          "User applied potentially restrictive review filter",
          {
            reviewFilter,
            userId,
            keyword,
            warning:
              "This filter may result in very few results or early termination",
          }
        );
      }
    }

    if (
      reviewTimeRange !== null &&
      reviewTimeRange !== "" &&
      (isNaN(reviewTimeRange) || reviewTimeRange < 0 || reviewTimeRange > 10)
    ) {
      return res
        .status(400)
        .json({ error: "reviewTimeRange must be a number between 0 and 10" });
    }

    // Validate isExtractEmail parameter
    if (isExtractEmail !== null && typeof isExtractEmail !== "boolean") {
      return res.status(400).json({
        error: "isExtractEmail must be a boolean value (true or false)",
      });
    }

    // Check user and apply plan-based restrictions
    const user = await User.findById(userId);
    const estimatedCredits = Math.ceil((maxRecords / 10) * 10);

    // Plan-based restrictions
    if (!user.hasUnlimitedAccess()) {
      // Restriction 1: maxRecords limit of 50 for free users (not business)
      if (maxRecords > 50) {
        return res.status(422).json({
          error: "Plan upgrade required",
          message:
            "Free plans are limited to 50 records per job. Please upgrade to Business plan for unlimited extractions.",
          currentPlan: user.plan,
          maxAllowed: 50,
          requested: maxRecords,
        });
      }

      // Restriction 2: Single active job limit for free users (not business)
      const activeJobsCount = await Job.countDocuments({
        userId,
        status: { $in: ["waiting", "active"] },
      });

      if (activeJobsCount > 0) {
        return res.status(429).json({
          error: "Active job limit exceeded",
          message:
            "Free plans can only run one job at a time. Please wait for your current job to complete or upgrade to Business plan.",
          currentPlan: user.plan,
          activeJobs: activeJobsCount,
        });
      }
    }

    // Credit check only for PRO users free users have unlimited extraction)
    if (
      !user.hasUnlimitedExtraction() &&
      user.credits.remaining < estimatedCredits
    ) {
      return res.status(402).json({
        error: "Insufficient credits",
        required: estimatedCredits,
        available: user.credits.remaining,
      });
    }

    // Generate unique job ID
    const jobId = uuidv4();

    // Create job parameters
    const jobParams = {
      keyword: keyword.trim(),
      city: city ? city.trim() : null,
      stateCode: stateCode ? stateCode.trim() : null,
      countryCode: countryCode.trim().toUpperCase(),
      maxRecords: parseInt(maxRecords),
      ratingFilter: ratingFilter,
      reviewFilter: reviewFilter,
      reviewTimeRange: reviewTimeRange ? parseInt(reviewTimeRange) : null,
      isExtractEmail: isExtractEmail,
    };

    // Create job record in database
    const jobRecord = await Job.create({
      jobId,
      userId,
      jobParams,
      status: "waiting",
      metrics: {
        creditsUsed: user.hasUnlimitedExtraction() ? 0 : estimatedCredits, // Track 0 for users with unlimited extraction
        estimatedCredits: estimatedCredits, // Keep original estimate for analytics
        planType: user.plan, // Track plan type for analytics
      },
    });

    // Deduct credits from user
    await user.deductCredits(estimatedCredits);

    // Add job to queue with jobId
    const queueJob = await scraperQueue.add(
      {
        ...jobParams,
        jobId,
        userId,
        dbJobId: jobRecord._id,
        timeout: 30 * 60 * 1000,
      },
      {
        jobId, // Use our custom jobId for the queue
        removeOnComplete: 10,
        removeOnFail: 5,
      }
    );

    res.json({
      jobId: jobRecord.jobId,
      // statusUrl: `/api/jobs/${jobRecord.jobId}`,
      message: "Scraping job queued successfully",
      // jobParams,
      // creditsUsed: estimatedCredits,
      // creditsRemaining: user.credits.remaining - estimatedCredits,
      // createdAt: jobRecord.createdAt,
      // status: jobRecord.status,
    });
  } catch (error) {
    console.error("Error creating scraping job:", error);
    res.status(500).json({
      error: "Internal server error",
      message: error.message,
    });
  }
};

const getJobStatus = async (req, res) => {
  try {
    const { jobId } = req.params;
    const userId = req.user.id;

    // Find job in database
    const jobRecord = await Job.findOne({
      jobId,
      userId,
    }).populate("userId", "name emailID");

    if (!jobRecord) {
      return res.status(404).json({ error: "Job not found" });
    }

    // Get job from queue for real-time progress
    const queueJob = await scraperQueue.getJob(jobId);

    let queueProgress = 0;
    let queueStatus = jobRecord.status;

    if (queueJob) {
      const progress = queueJob.progress();
      queueStatus = await queueJob.getState();

      if (typeof progress === "number") {
        queueProgress = progress;
      } else if (typeof progress === "object") {
        queueProgress = progress.percentage || 0;
      }

      // Update database record if status changed
      if (queueStatus !== jobRecord.status) {
        await jobRecord.updateStatus(queueStatus, {
          progress: {
            percentage: queueProgress,
            details: typeof progress === "object" ? progress : {},
          },
        });
      }
    }

    console.log(queueJob);
    res.json({
      id: jobRecord.jobId,
      status: queueStatus,
      progress: {
        percentage: queueProgress,
        details: jobRecord.progress.details,
      },
      result: queueJob.returnvalue || null,
      // result: jobRecord.result || (queueJob ? queueJob.returnvalue : null),
      jobParams: jobRecord.jobParams,
      metrics: jobRecord.metrics,
      createdAt: jobRecord.createdAt,
      startedAt: jobRecord.startedAt,
      completedAt: jobRecord.completedAt,
      duration: {
        raw: jobRecord.duration, // milliseconds
        seconds: jobRecord.durationSeconds,
        formatted: jobRecord.durationFormatted, // e.g., "5m 30s"
      },
    });
  } catch (error) {
    console.error("Error fetching job status:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export default { scrapeData, getJobStatus };
