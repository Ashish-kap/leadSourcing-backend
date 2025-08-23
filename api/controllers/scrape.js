// import scraperQueue from "../../services/queue.js";

// const scrapeData = async (req, res) => {
//   try {
//     const {
//       keyword,
//       city = null,
//       countryCode,
//       stateCode = null,
//       maxRecords = 50,
//       minRating = 0,
//       reviewTimeRange = null,
//     } = req.body;

//     // Validate mandatory fields
//     if (!keyword) {
//       return res.status(400).json({
//         error: "keyword is required",
//       });
//     }

//     if (!countryCode) {
//       return res.status(400).json({
//         error: "countryCode is required",
//       });
//     }

//     // Validate numeric parameters
//     if (
//       maxRecords &&
//       (isNaN(maxRecords) || maxRecords < 1 || maxRecords > 1000)
//     ) {
//       return res.status(400).json({
//         error: "maxRecords must be a number between 1 and 1000",
//       });
//     }

//     if (minRating && (isNaN(minRating) || minRating < 0 || minRating > 5)) {
//       return res.status(400).json({
//         error: "minRating must be a number between 0 and 5",
//       });
//     }

//     if (
//       reviewTimeRange &&
//       (isNaN(reviewTimeRange) || reviewTimeRange < 0 || reviewTimeRange > 10)
//     ) {
//       return res.status(400).json({
//         error: "reviewTimeRange must be a number between 0 and 10",
//       });
//     }

//     // Create job with all parameters
//     const job = await scraperQueue.add({
//       keyword: keyword.trim(),
//       city: city ? city.trim() : null,
//       stateCode: stateCode ? stateCode.trim() : null,
//       countryCode: countryCode.trim().toUpperCase(), // Standardize country code
//       maxRecords: parseInt(maxRecords),
//       minRating: parseFloat(minRating),
//       reviewTimeRange: parseInt(reviewTimeRange),
//     });

//     res.json({
//       jobId: job.id,
//       statusUrl: `/jobs/${job.id}`,
//       message: "Scraping job queued successfully",
//       jobParams: {
//         keyword,
//         city,
//         stateCode,
//         countryCode,
//         maxRecords: parseInt(maxRecords),
//         minRating: parseFloat(minRating),
//         reviewTimeRange: parseInt(reviewTimeRange),
//         // estimatedLocations: getEstimatedLocations(city, state, country),
//       },
//     });
//   } catch (error) {
//     console.error("Error creating scraping job:", error);
//     res.status(500).json({
//       error: "Internal server error",
//       message: error.message,
//     });
//   }
// };

// const getData = async (req, res) => {
//   try {
//     const job = await scraperQueue.getJob(req.params.id);
//     if (!job) return res.status(404).json({ error: "Job not found" });

//     const progress = job.progress();
//     let percentage = 0;
//     let details = {};

//     console.log("progr", progress);

//     // Handle both number and object progress
//     if (typeof progress === "number") {
//       percentage = progress;
//     } else if (typeof progress === "object") {
//       percentage = progress.percentage || 0;
//       details = progress;
//     }

//     res.json({
//       id: job.id,
//       status: await job.getState(),
//       progress: {
//         percentage,
//         details,
//       },
//       result: job.returnvalue,
//     });
//   } catch (error) {
//     res.status(500).json({ error: "Internal server error" });
//   }
// };

// export default { scrapeData, getData };

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
      minRating = 0,
      reviewTimeRange = null,
    } = req.body;

    // Get user from auth middleware (assuming you have auth middleware)

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
    if (
      maxRecords &&
      (isNaN(maxRecords) || maxRecords < 1 || maxRecords > 1000)
    ) {
      return res.status(400).json({
        error: "maxRecords must be a number between 1 and 1000",
      });
    }

    if (minRating && (isNaN(minRating) || minRating < 0 || minRating > 5)) {
      return res.status(400).json({
        error: "minRating must be a number between 0 and 5",
      });
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

    // Check user credits
    const user = await User.findById(userId);
    const estimatedCredits = Math.ceil((maxRecords / 10) * 10);

    if (user.credits.remaining < estimatedCredits) {
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
      minRating: parseFloat(minRating),
      reviewTimeRange: reviewTimeRange ? parseInt(reviewTimeRange) : null,
    };

    // Create job record in database
    const jobRecord = await Job.create({
      jobId,
      userId,
      jobParams,
      status: "waiting",
      metrics: {
        creditsUsed: estimatedCredits,
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
      duration: jobRecord.duration,
    });
  } catch (error) {
    console.error("Error fetching job status:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export default { scrapeData, getJobStatus };
