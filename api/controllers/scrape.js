import queueService from "../../services/queue.js";
import Job from "./../../models/jobModel.js";
import User from "./../../models/userModel.js";
import { v4 as uuidv4 } from "uuid";
import { sanitizeKeyword, validateKeyword, sanitizeKeywordWithSeparators } from "../../utils/keywordSanitizer.js";

const { getQueueForUser, businessQueue, freeProQueue } = queueService;


const scrapeData = async (req, res) => {
  try {
    const {
      keyword,
      city = null,
      countryCode,
      stateCode = null,
      maxRecords = 50, // Default value - will be validated against user's plan limit
      ratingFilter = null,
      reviewFilter = null,
      reviewTimeRange = null,
      isExtractEmail = false,
      isValidate = false,
      extractNegativeReviews = false,
      avoidDuplicate = false,
    } = req.body;

    // Get user from auth middleware (assuming you have auth middleware)
    const userId = req.user.id;

    // Validate and sanitize keyword
    if (!keyword) {
      return res.status(400).json({
        error: "keyword is required",
      });
    }

    // Sanitize keyword while preserving separators
    const keywordSanitization = sanitizeKeywordWithSeparators(keyword);
    
    if (!keywordSanitization.isValid) {
      return res.status(400).json({
        error: "Invalid keyword",
        message: "Please provide a valid keyword with at least 2 characters",
        details: keywordSanitization.warnings,
        originalKeyword: keywordSanitization.original,
        suggestions: [
          "Use clear, descriptive terms",
          "You can include multiple keywords separated by commas, semicolons, or pipes",
          "Examples: 'restaurant', 'plumber, restaurant, cafe', 'dentist; doctor', 'spa | salon'"
        ]
      });
    }

    // Additional validation
    const keywordValidation = validateKeyword(keywordSanitization.cleaned);
    if (!keywordValidation.isValid) {
      return res.status(400).json({
        error: "Keyword validation failed",
        issues: keywordValidation.issues,
        suggestions: keywordValidation.suggestions,
        cleanedKeyword: keywordSanitization.cleaned
      });
    }

    // Log sanitization for monitoring
    if (keywordSanitization.warnings.length > 0) {
      console.warn("KEYWORD_SANITIZATION", "Keyword was cleaned", {
        original: keywordSanitization.original,
        cleaned: keywordSanitization.cleaned,
        warnings: keywordSanitization.warnings,
        hasSeparators: keywordSanitization.hasSeparators,
        separatorCount: keywordSanitization.separatorCount,
        userId: req.user.id
      });
    }

    // Use the cleaned keyword
    const cleanKeyword = keywordSanitization.cleaned;

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

    // Validate isValidate parameter
    if (isValidate !== null && typeof isValidate !== "boolean") {
      return res.status(400).json({
        error: "isValidate must be a boolean value (true or false)",
      });
    }

    // Logical validation: isValidate can only be true if isExtractEmail is true
    if (isValidate === true && isExtractEmail !== true) {
      return res.status(400).json({
        error: "isValidate can only be true when isExtractEmail is also true",
        message:
          "Email validation requires email extraction to be enabled first",
      });
    }

    // Check user and apply plan-based restrictions
    const user = await User.findById(userId);
    const estimatedCredits = Math.ceil((maxRecords / 10) * 10);

    // Restriction 1: Single active job limit for ALL users (free, pro, business)
    const activeJobsCount = await Job.countDocuments({
      userId,
      status: { $in: ["waiting", "active"] },
    });

    if (activeJobsCount > 0) {
      return res.status(429).json({
        error: "Active job limit exceeded",
        message:
          "Please wait for your current job to complete before starting a new one.",
        currentPlan: user.plan,
        activeJobs: activeJobsCount,
      });
    }

    // Restriction 2: Plan-based maxRecords limit
    const maxAllowedRecords = user.getMaxRecordsLimit();
    if (maxRecords > maxAllowedRecords) {
      const planUpgradeMessage = user.plan === "free" 
        ? "Free plans are limited to 50 records. Please upgrade to Pro plan for up to 1,000 records or Business plan for up to 3,000 records."
        : user.plan === "pro"
        ? "Pro plans are limited to 1,000 records. Please upgrade to Business plan for up to 3,000 records."
        : "Please contact support for higher limits.";
      
      return res.status(422).json({
        error: "Plan upgrade required",
        message: planUpgradeMessage,
        currentPlan: user.plan,
        maxAllowed: maxAllowedRecords,
        requested: maxRecords,
        planLimits: {
          free: 50,
          pro: 1000,
          business: 3000
        }
      });
    }

    // Credit check only for PRO users free users have unlimited extraction)
    if (
      !user.hasUnlimitedExtraction() &&
      user.credits.remaining < estimatedCredits
    ) {
      return res.status(402).json({
        // error: "Insufficient credits",
        error: "Plan upgrade required",
        message:
          "Looks like you're doing serious data extraction! Upgrade to Business plan for unlimited extractions and take your lead sourcing to the next level.",
        required: estimatedCredits,
        available: user.credits.remaining,
      });
    }

    // Generate unique job ID
    const jobId = uuidv4();

    // Create job parameters
    const jobParams = {
      keyword: cleanKeyword, // Use the keyword as-is (supports multiple keywords)
      city: city ? city.trim() : null,
      stateCode: stateCode ? stateCode.trim() : null,
      countryCode: countryCode.trim().toUpperCase(),
      maxRecords: parseInt(maxRecords),
      ratingFilter: ratingFilter,
      reviewFilter: reviewFilter,
      reviewTimeRange: reviewTimeRange ? parseInt(reviewTimeRange) : null,
      isExtractEmail: isExtractEmail,
      isValidate: isValidate,
      extractNegativeReviews: Boolean(extractNegativeReviews),
      avoidDuplicate: Boolean(avoidDuplicate),
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

    // Select appropriate queue based on user plan
    const selectedQueue = getQueueForUser(user.plan);
    const queueName = user.plan === "business" ? "Business" : "Free/Pro";

    console.log(
      `Adding job ${jobId} to ${queueName} queue for user plan: ${user.plan}`
    );

    // Add job to the appropriate queue
    const queueJob = await selectedQueue.add(
      {
        ...jobParams,
        jobId,
        userId,
        dbJobId: jobRecord._id,
        userPlan: user.plan, // Track which plan for analytics
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
    }).populate("userId", "name emailID plan");

    if (!jobRecord) {
      return res.status(404).json({ error: "Job not found" });
    }

    // Get job from the appropriate queue based on user plan
    const userPlan = jobRecord.userId.plan;
    const selectedQueue = getQueueForUser(userPlan);
    const queueJob = await selectedQueue.getJob(jobId);

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
