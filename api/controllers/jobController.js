import queueService from "../../services/queue.js";
import Job from "./../../models/jobModel.js";
import User from "./../../models/userModel.js";
import { Parser } from "json2csv";
import socketService from "../../services/socket.service.js";

const { getQueueForUser, businessQueue, freeProQueue } = queueService;

const getUserJobs = async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      page = 1,
      limit = 10,
      status,
      sortBy = "createdAt",
      order = "desc",
      keyword,
      startDate,
      endDate,
    } = req.query;

    // Build filter query
    const filter = { userId };

    if (status) {
      filter.status = status;
    }

    if (keyword) {
      filter["jobParams.keyword"] = new RegExp(keyword, "i");
    }

    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) filter.createdAt.$gte = new Date(startDate);
      if (endDate) filter.createdAt.$lte = new Date(endDate);
    }

    // Calculate pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const sortOrder = order === "desc" ? -1 : 1;

    // Get jobs with pagination
    const jobs = await Job.find(filter)
      .sort({ [sortBy]: sortOrder })
      .skip(skip)
      .limit(parseInt(limit))
      .select("-__v");

    // Get total count for pagination
    const totalJobs = await Job.countDocuments(filter);
    const totalPages = Math.ceil(totalJobs / parseInt(limit));

    res.json({
      success: true,
      data: {
        jobs: jobs.map((job) => ({
          id: job.jobId,
          keyword: job.jobParams.keyword,
          location: [
            job.jobParams.city,
            job.jobParams.stateCode,
            job.jobParams.countryCode,
          ]
            .filter(Boolean)
            .join(", "),
          status: job.status,
          progress: job.progress.percentage,
          maxRecords: job.jobParams.maxRecords,
          recordsCollected: job.metrics?.dataPointsCollected || 0,
          createdAt: job.createdAt,
          startedAt: job.startedAt,
          completedAt: job.completedAt,
          duration: {
            raw: job.duration, // milliseconds
            seconds: job.durationSeconds,
            formatted: job.durationFormatted, // e.g., "5m 30s"
          },
        })),
        pagination: {
          currentPage: parseInt(page),
          totalPages,
          totalJobs,
          hasNextPage: parseInt(page) < totalPages,
          hasPrevPage: parseInt(page) > 1,
        },
      },
    });
  } catch (error) {
    console.error("Error fetching user jobs:", error);
    res.status(500).json({
      success: false,
      error: "Internal server error",
      message: error.message,
    });
  }
};

const getJobDetails = async (req, res) => {
  try {
    const { jobId } = req.params;
    const userId = req.user.id;

    const job = await Job.findOne({ jobId, userId })
      .populate("userId", "name emailID")
      .select("-__v");

    if (!job) {
      return res.status(404).json({
        success: false,
        error: "Job not found",
      });
    }

    res.json({
      success: true,
      data: {
        id: job.jobId,
        status: job.status,
        progress: job.progress,
        jobParams: job.jobParams,
        metrics: job.metrics,
        result: job.result,
        error: job.error,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        duration: {
          raw: job.duration, // milliseconds
          seconds: job.durationSeconds,
          formatted: job.durationFormatted, // e.g., "5m 30s"
        },
        user: job.userId,
      },
    });
  } catch (error) {
    console.error("Error fetching job details:", error);
    res.status(500).json({
      success: false,
      error: "Internal server error",
      message: error.message,
    });
  }
};

const getUserDashboard = async (req, res) => {
  try {
    const userId = req.user.id;

    // Get user with credits and plan info
    const user = await User.findById(userId).select(
      "name emailID credits plan"
    );

    res.json({
      success: true,
      data: {
        user: {
          // name: user.name,
          // email: user.emailID,
          credits: user.hasUnlimitedExtraction()
            ? { unlimited: true }
            : user.credits,
          creditPercentage: user.hasUnlimitedExtraction()
            ? null
            : user.creditPercentage,
          plan: user.plan,
          hasUnlimitedAccess: user.hasUnlimitedAccess(),
          hasUnlimitedExtraction: user.hasUnlimitedExtraction(),
        },
      },
    });
  } catch (error) {
    console.error("Error fetching dashboard data:", error);
    res.status(500).json({
      success: false,
      error: "Internal server error",
      message: error.message,
    });
  }
};

const deleteJob = async (req, res) => {
  try {
    const { jobId } = req.params;
    const userId = req.user.id;

    const job = await Job.findOne({ jobId, userId }).populate("userId", "plan");

    if (!job) {
      return res.status(404).json({
        success: false,
        error: "Job not found",
      });
    }

    // Kill the job if it's active/running in the queue
    if (["pending", "active", "waiting"].includes(job.status)) {
      try {
        // Calculate credits to refund
        const creditsToRefund = job.metrics?.creditsUsed || 0;
        
        // Refund credits to user if job was charged
        if (creditsToRefund > 0) {
          try {
            const user = await User.findById(userId);
            if (user) {
              await user.refundCredits(creditsToRefund);
              console.log(
                `Refunded ${creditsToRefund} credits to user ${userId} for cancelled job ${jobId}`
              );
            }
          } catch (refundError) {
            console.error(
              `Error refunding credits for job ${jobId}:`,
              refundError.message
            );
            // Continue with job deletion even if refund fails
          }
        }

        // Update database to mark as failed (this triggers cancellation detection)
        await Job.findOneAndUpdate(
          { jobId, userId },
          {
            status: "failed",
            "progress.percentage": 0,
            completedAt: new Date(),
            "metrics.creditsRefunded": creditsToRefund,
            error: {
              message: "Job cancelled by user deletion",
              timestamp: new Date(),
            },
          }
        );

        // Get the appropriate queue based on user plan
        const userPlan = job.userId.plan;
        const selectedQueue = getQueueForUser(userPlan);

        const queueJob = await selectedQueue.getJob(jobId);
        if (queueJob) {
          // Check if job is active and move to failed
          if (await queueJob.isActive()) {
            await queueJob.moveToFailed(
              new Error("Job cancelled by user deletion"),
              true
            );
            console.log(
              `Moved active job ${jobId} to failed state in ${userPlan} queue`
            );
          } else {
            // If not active, try to remove it
            try {
              await queueJob.remove();
              console.log(
                `Removed waiting job ${jobId} from ${userPlan} queue`
              );
            } catch (removeError) {
              // Job might be transitioning states, that's okay
              console.log(`Job ${jobId} removal skipped (state transition)`);
            }
          }
        }
      } catch (queueError) {
        console.error(
          `Error cancelling job ${jobId} from queue:`,
          queueError.message
        );
        // Continue with database deletion even if queue cleanup fails
      }
    }

    // Store job status for message and socket event
    const wasActive = ["pending", "active", "waiting"].includes(job.status);
    const creditsRefunded = job.metrics?.creditsRefunded || 0;

    // Delete job from database
    await Job.findByIdAndDelete(job._id);

    // Emit socket event to notify frontend
    socketService.emitJobUpdate(userId, "job_deleted", {
      jobId: job.jobId,
      status: "deleted",
      wasActive: wasActive,
      progress: wasActive ? { percentage: 0 } : undefined, // ✅ Reset progress for cancelled jobs
      deletedAt: new Date(),
      creditsRefunded: creditsRefunded,
    });

    // Create response message
    let message = `Job deleted successfully`;
    if (wasActive) {
      message += " (and cancelled)";
    }
    if (creditsRefunded > 0) {
      message += ` - ${creditsRefunded} credits refunded`;
    }

    res.json({
      success: true,
      message: message,
      creditsRefunded: creditsRefunded,
    });
  } catch (error) {
    console.error("Error deleting job:", error);
    res.status(500).json({
      success: false,
      error: "Internal server error",
      message: error.message,
    });
  }
};

const killJob = async (req, res) => {
  try {
    const { jobId } = req.params;

    // Try both queues to find the job
    let job = await businessQueue.getJob(jobId);
    let queueName = "business";

    if (!job) {
      job = await freeProQueue.getJob(jobId);
      queueName = "free/pro";
    }

    if (job && (await job.isActive())) {
      // Get job data to calculate credits to refund
      const jobData = job.data;
      const creditsToRefund = jobData.maxRecords ? Math.ceil((jobData.maxRecords / 10) * 10) : 0;
      
      // Refund credits to user if job was charged
      if (creditsToRefund > 0 && jobData.userId) {
        try {
          const user = await User.findById(jobData.userId);
          if (user) {
            await user.refundCredits(creditsToRefund);
            console.log(
              `Refunded ${creditsToRefund} credits to user ${jobData.userId} for killed job ${jobId}`
            );
          }
        } catch (refundError) {
          console.error(
            `Error refunding credits for killed job ${jobId}:`,
            refundError.message
          );
          // Continue with job killing even if refund fails
        }
      }

      await job.moveToFailed(
        new Error("Manually killed via admin endpoint"),
        true
      );
      res.json({
        status: "killed",
        id: job.id,
        queue: queueName,
        creditsRefunded: creditsToRefund,
      });
    } else {
      res.status(404).json({ error: "Not found or not active" });
    }
  } catch (error) {
    console.error("Error killing job:", error);
    res
      .status(500)
      .json({ error: "Internal server error", message: error.message });
  }
};

export const downloadJobResultCSV = async (req, res) => {
  try {
    const { jobId } = req.params;
    const job = await Job.findOne({ jobId: jobId });

    if (!job || !job.result || !Array.isArray(job.result)) {
      return res.status(404).json({ error: "Result data not found" });
    }

    // Flatten nested filtered_reviews for CSV and convert email array to comma-separated string
    const flatData = job.result.map((row) => {
      const processedRow = { ...row };

      // Remove email_verification field from the data
      delete processedRow.email_verification;

      // Convert email array to comma-separated string AFTER processing email_status
      if (processedRow.email && Array.isArray(processedRow.email)) {
        processedRow.email =
          processedRow.email.length > 0 ? processedRow.email.join(", ") : "";
      }

      if (
        processedRow.email_status &&
        Array.isArray(processedRow.email_status)
      ) {
        processedRow.email_status =
          processedRow.email_status.length > 0
            ? processedRow.email_status.join(", ")
            : "";
      }

      if (row.filtered_reviews && Array.isArray(row.filtered_reviews)) {
        // Extract up to 2 reviews with all their details
        const review1 = row.filtered_reviews[0];
        const review2 = row.filtered_reviews[1];
        
        // Function to sanitize review text
        const sanitizeReviewText = (text) => {
          if (!text) return "";
          
          return text
            // Remove or replace problematic Unicode characters
            .replace(/[\u201C\u201D]/g, '"') // Replace smart quotes with regular quotes
            .replace(/[\u2018\u2019]/g, "'") // Replace smart apostrophes with regular apostrophes
            .replace(/[\u2013\u2014]/g, "-") // Replace en-dash and em-dash with regular dash
            .replace(/[\u2026]/g, "...") // Replace ellipsis with three dots
            .replace(/[\u00A0]/g, " ") // Replace non-breaking space with regular space
            // Remove other problematic characters
            .replace(/[^\x20-\x7E\u00A0-\u00FF\u0100-\u017F\u0180-\u024F\u1E00-\u1EFF]/g, "")
            // Clean up multiple spaces
            .replace(/\s+/g, " ")
            // Trim whitespace
            .trim();
        };
        
        return {
          ...processedRow,
          reviews_count: row.filtered_reviews.length,
          review_1_date: review1?.date || "",
          review_1_rating: review1?.rating || "",
          reviewer_1_name: review1?.reviewerName || "",
          review_1_text: sanitizeReviewText(review1?.text),
          review_2_date: review2?.date || "",
          review_2_rating: review2?.rating || "",
          reviewer_2_name: review2?.reviewerName || "",
          review_2_text: sanitizeReviewText(review2?.text),
        };
      }
      return processedRow;
    });

    // Convert to CSV
    const parser = new Parser();
    const csv = parser.parse(flatData);

    res.header("Content-Type", "text/csv");
    res.attachment(`job_${jobId}_result.csv`);
    return res.send(csv);
  } catch (err) {
    console.error("Error downloading job result:", err);
    res.status(500).json({ error: "Internal server error" });
  }
};

export default {
  getUserJobs,
  downloadJobResultCSV,
  getJobDetails,
  getUserDashboard,
  deleteJob,
  killJob,
};
