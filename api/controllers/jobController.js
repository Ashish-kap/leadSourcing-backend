import scraperQueue from "../../services/queue.js";
import Job from "./../../models/jobModel.js";
import User from "./../../models/userModel.js";
import { Parser } from "json2csv";
import socketService from "../../services/socket.service.js";

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

    const job = await Job.findOne({ jobId, userId });

    if (!job) {
      return res.status(404).json({
        success: false,
        error: "Job not found",
      });
    }

    // Kill the job if it's active/running in the queue
    if (["pending", "active", "waiting"].includes(job.status)) {
      try {
        // Update database to reset progress before killing
        await Job.findOneAndUpdate(
          { jobId, userId },
          {
            status: "failed",
            "progress.percentage": 0,
            completedAt: new Date(),
            error: {
              message: "Job cancelled by user deletion",
              timestamp: new Date(),
            },
          }
        );

        const queueJob = await scraperQueue.getJob(jobId);
        if (queueJob) {
          // Check if job is active and kill it
          if (await queueJob.isActive()) {
            await queueJob.moveToFailed(
              new Error("Job cancelled by user deletion"),
              true
            );
            console.log(`Killed active job ${jobId} before deletion`);
          }
          // Remove job from queue completely
          await queueJob.remove();
          console.log(`Removed job ${jobId} from queue`);
        }
      } catch (queueError) {
        console.error(
          `Error killing/removing job ${jobId} from queue:`,
          queueError
        );
        // Continue with database deletion even if queue cleanup fails
      }
    }

    // Store job status for message and socket event
    const wasActive = ["pending", "active", "waiting"].includes(job.status);

    // Delete job from database
    await Job.findByIdAndDelete(job._id);

    // Emit socket event to notify frontend
    socketService.emitJobUpdate(userId, "job_deleted", {
      jobId: job.jobId,
      status: "deleted",
      wasActive: wasActive,
      progress: wasActive ? { percentage: 0 } : undefined, // ✅ Reset progress for cancelled jobs
      deletedAt: new Date(),
    });

    res.json({
      success: true,
      message: `Job deleted successfully ${wasActive ? "(and cancelled)" : ""}`,
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
  const job = await scraperQueue.getJob(req.params.jobId);
  if (job && job.isActive()) {
    await job.moveToFailed(
      new Error("Manually killed via admin endpoint"),
      true
    );
    res.json({ status: "killed", id: job.id });
  } else {
    res.status(404).json({ error: "Not found or not active" });
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
        // pick first review only, or join texts, or explode into multiple rows
        return {
          ...processedRow,
          reviews_count: row.filtered_reviews.length,
          review_1_text: row.filtered_reviews[0]?.text,
          review_1_rating: row.filtered_reviews?.rating,
          review_1_date: row.filtered_reviews?.date,
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
