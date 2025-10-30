import dotenv from "dotenv";
dotenv.config();
import Queue from "bull";
import scrapeJob from "../jobs/scrapeJob.js";
import Job from "../models/jobModel.js";
import User from "../models/userModel.js";
import socketService from "./socket.service.js";
import logger from "./logger.js";

let redisObj;

if (process.env.REDIS_HOST) {
  try {
    const redisUrl = new URL(process.env.REDIS_HOST);
    redisObj = {
      host: redisUrl.hostname,
      port: parseInt(redisUrl.port, 10) || 6379,
      password: redisUrl.password
        ? redisUrl.password.replace(/^default:/, "")
        : undefined,
    };
  } catch (e) {
    redisObj = {
      host: process.env.REDIS_HOST,
      port: 6379,
    };
  }
} else {
  redisObj = {
    host: "localhost",
    port: 6379,
  };
}

// Queue configuration - Direct worker allocation (no percentages)
const BUSINESS_WORKERS = parseInt(process.env.BUSINESS_WORKERS) || 5;
const FREE_PRO_WORKERS = parseInt(process.env.FREE_PRO_WORKERS) || 3;
const TOTAL_WORKERS = BUSINESS_WORKERS + FREE_PRO_WORKERS;

logger.info(
  "QUEUE_INIT",
  `Initializing queues with ${TOTAL_WORKERS} total workers: ${BUSINESS_WORKERS} business, ${FREE_PRO_WORKERS} free/pro`
);

// Shared queue settings
// lockDuration: 4 hours (longer than max job duration of 3 hours to prevent lock expiration)
// lockRenewTime: 2 hours (automatically renew lock every 2 hours for long-running jobs)
const queueSettings = {
  redis: redisObj,
  settings: {
    stalledInterval: 60000,
    maxStalledCount: 2,
    guardInterval: 3000,
    retryProcessDelay: 3000,
    lockDuration: 14400000, // 4 hours (longer than max job duration of 3 hours)
  },
  defaultJobOptions: {
    removeOnComplete: 10,
    removeOnFail: 10,
    lockRenewTime: 7200000, // Renew lock every 2 hours (must be less than lockDuration)
    backoff: {
      type: "exponential",
      delay: 2000,
    },
  },
};

// Create separate queues for different user tiers
const businessQueue = new Queue("scraper-business", queueSettings);
const freeProQueue = new Queue("scraper-free-pro", queueSettings);

// Helper function to attach event handlers to a queue
const attachEventHandlers = (queue, queueName) => {
  queue.on("error", (err) => {
    // Ignore "missing lock" errors - these are expected when jobs are cancelled
    if (err?.message?.includes("Missing lock for job")) {
      logger.warn(
        "JOB_LOCK_EXPECTED",
        `${queueName}: Job lock error (expected for cancelled jobs)`,
        { message: err.message }
      );
      return;
    }
    logger.error("REDIS_ERROR", `${queueName}: Redis connection error`, err);
  });

  queue.on("connected", () => {
    logger.info(
      "REDIS_CONNECTED",
      `${queueName}: Successfully connected to Redis`
    );
  });

  queue.on("active", async (job) => {
    logger.info("JOB_ACTIVE", `${queueName}: Job ${job.id} started processing`);

    try {
      const updatedJob = await Job.findOneAndUpdate(
        { jobId: job.data.jobId },
        {
          status: "active",
          startedAt: new Date(),
        },
        { new: true }
      );

      if (updatedJob) {
        socketService.emitJobUpdate(
          updatedJob.userId.toString(),
          "job_started",
          {
            jobId: updatedJob.jobId,
            status: "active",
            startedAt: updatedJob.startedAt,
            progress: updatedJob.progress,
          }
        );
      }
    } catch (error) {
      logger.error(
        "JOB_UPDATE_ERROR",
        `${queueName}: Error updating job ${job.id} to active`,
        error
      );
    }
  });

  queue.on("progress", async (job, progress) => {
    logger.info(
      "JOB_PROGRESS",
      `${queueName}: Job ${job.id} progress`,
      progress
    );

    try {
      const updateData = {
        "progress.percentage":
          typeof progress === "number" ? progress : progress.percentage || 0,
      };

      if (typeof progress === "object") {
        updateData["progress.details"] = progress;
      }

      const updatedJob = await Job.findOneAndUpdate(
        { jobId: job.data.jobId },
        updateData,
        { new: true }
      );

      if (updatedJob) {
        socketService.emitJobProgress(
          updatedJob.userId.toString(),
          updatedJob.jobId,
          {
            percentage: updateData["progress.percentage"],
            details: progress.details || progress,
          }
        );
      }
    } catch (error) {
      logger.error(
        "JOB_PROGRESS_ERROR",
        `${queueName}: Error updating job ${job.id} progress`,
        error
      );
    }
  });

  queue.on("completed", async (job, result) => {
    logger.info("JOB_COMPLETED", `${queueName}: Job ${job.id} completed`);

    const totalExtractions = result?.length || 0;
    
    // Check if job was stuck timeout to determine appropriate status
    const dbJob = await Job.findOne({ jobId: job.data.jobId });
    const jobStatus = dbJob?.status === "stuck_timeout" 
      ? "stuck_timeout" 
      : totalExtractions > 0 ? "completed" : "data_not_found";

    logger.info(
      "JOB_FINISHED",
      `${queueName}: Job ${job.id} finished with ${totalExtractions} records, status: ${jobStatus}`
    );

    try {
      // Calculate actual credits used and refund if necessary
      const maxRecordsRequested = job.data.maxRecords || 0;
      const estimatedCredits = Math.ceil((maxRecordsRequested / 10) * 10);
      const actualCreditsUsed = Math.ceil((totalExtractions / 10) * 10);
      const creditsToRefund = Math.max(0, estimatedCredits - actualCreditsUsed);

      logger.info(
        "CREDIT_CALCULATION",
        `${queueName}: Job ${job.id} - Requested: ${maxRecordsRequested}, Got: ${totalExtractions}, Estimated: ${estimatedCredits}, Actual: ${actualCreditsUsed}, Refund: ${creditsToRefund}`
      );

      // Refund credits if user got fewer records than requested
      if (creditsToRefund > 0) {
        try {
          const user = await User.findById(job.data.userId);
          if (user) {
            await user.refundCredits(creditsToRefund);
            logger.info(
              "CREDIT_REFUND",
              `${queueName}: Refunded ${creditsToRefund} credits to user ${job.data.userId} for job ${job.id}`
            );
          }
        } catch (refundError) {
          logger.error(
            "CREDIT_REFUND_ERROR",
            `${queueName}: Error refunding credits for job ${job.id}`,
            refundError
          );
        }
      }

      const updatedJob = await Job.findOneAndUpdate(
        { jobId: job.data.jobId },
        {
          status: jobStatus,
          completedAt: new Date(),
          result: result,
          "progress.percentage": 100,
          "metrics.totalExtractions": totalExtractions,
          "metrics.creditsUsed": actualCreditsUsed,
          "metrics.creditsRefunded": creditsToRefund,
        },
        { new: true }
      );

      if (updatedJob) {
        let eventType;
        let message;
        
        if (jobStatus === "stuck_timeout") {
          eventType = "job_stuck_timeout";
          message = `Job completed with partial results (${totalExtractions} records) due to timeout. The job was taking too long to progress and was terminated to prevent resource waste.`;
        } else if (jobStatus === "completed") {
          eventType = "job_completed";
          message = `Successfully extracted ${totalExtractions} records.`;
        } else {
          eventType = "job_no_data_found";
          message = "No data found matching your search criteria. Try adjusting your filters or location.";
        }

        socketService.emitJobUpdate(updatedJob.userId.toString(), eventType, {
          jobId: updatedJob.jobId,
          status: jobStatus,
          completedAt: updatedJob.completedAt,
          progress: { percentage: 100 },
          totalExtractions: totalExtractions,
          creditsRefunded: creditsToRefund,
          message: message,
        });
      }
    } catch (error) {
      // Handle lock expiration errors gracefully - job completed but lock was already expired
      if (error?.message?.includes("Missing lock for job")) {
        logger.warn(
          "JOB_COMPLETION_LOCK_EXPIRED",
          `${queueName}: Job ${job.id} completed but lock had expired (this is expected for long-running jobs)`,
          { 
            jobId: job.data?.jobId,
            totalExtractions: totalExtractions,
            message: error.message 
          }
        );
        // Job still completed successfully, just log the lock expiration
        return;
      }
      logger.error(
        "JOB_COMPLETION_ERROR",
        `${queueName}: Error updating completed job ${job.id}`,
        error
      );
    }
  });

  queue.on("failed", async (job, err) => {
    // Ignore "missing lock" errors - these happen when job was already moved to failed
    if (err?.message?.includes("Missing lock for job")) {
      logger.warn(
        "JOB_ALREADY_FAILED",
        `${queueName}: Job ${job.id} was already moved to failed state (likely cancelled)`,
        { jobId: job.data?.jobId }
      );
      return;
    }

    logger.error("JOB_FAILED", `${queueName}: Job ${job.id} failed`, err);

    try {
      // Calculate credits to refund for failed job
      const maxRecordsRequested = job.data.maxRecords || 0;
      const estimatedCredits = Math.ceil((maxRecordsRequested / 10) * 10);
      const creditsToRefund = estimatedCredits; // Full refund for failed jobs

      logger.info(
        "CREDIT_REFUND_FAILED",
        `${queueName}: Job ${job.id} failed - Refunding full ${creditsToRefund} credits to user ${job.data.userId}`
      );

      // Refund all credits for failed job
      if (creditsToRefund > 0) {
        try {
          const user = await User.findById(job.data.userId);
          if (user) {
            await user.refundCredits(creditsToRefund);
            logger.info(
              "CREDIT_REFUND_SUCCESS",
              `${queueName}: Successfully refunded ${creditsToRefund} credits to user ${job.data.userId} for failed job ${job.id}`
            );
          }
        } catch (refundError) {
          logger.error(
            "CREDIT_REFUND_ERROR",
            `${queueName}: Error refunding credits for failed job ${job.id}`,
            refundError
          );
        }
      }

      const updatedJob = await Job.findOneAndUpdate(
        { jobId: job.data.jobId },
        {
          status: "failed",
          completedAt: new Date(),
          "progress.percentage": 0,
          "metrics.totalExtractions": 0,
          "metrics.creditsUsed": 0,
          "metrics.creditsRefunded": creditsToRefund,
          error: {
            message: err.message,
            stack: err.stack,
            timestamp: new Date(),
          },
        },
        { new: true }
      );

      if (updatedJob) {
        socketService.emitJobUpdate(
          updatedJob.userId.toString(),
          "job_failed",
          {
            jobId: updatedJob.jobId,
            status: "failed",
            completedAt: updatedJob.completedAt,
            progress: { percentage: 0 },
            creditsRefunded: creditsToRefund,
            error: {
              message: err.message,
              timestamp: new Date(),
            },
            message: `Job failed due to an error. All ${creditsToRefund} credits have been refunded to your account.`,
          }
        );
      }
    } catch (error) {
      logger.error(
        "JOB_FAILURE_ERROR",
        `${queueName}: Error updating failed job ${job.id}`,
        error
      );
    }
  });
};

// Attach event handlers to both queues
attachEventHandlers(businessQueue, "BusinessQueue");
attachEventHandlers(freeProQueue, "FreeProQueue");

// Process jobs with dedicated workers for each queue
businessQueue.process(BUSINESS_WORKERS, scrapeJob);
freeProQueue.process(FREE_PRO_WORKERS, scrapeJob);

// Export both queues and a helper function to get the right queue
export { businessQueue, freeProQueue };

// Helper function to select the appropriate queue based on user plan
export const getQueueForUser = (userPlan) => {
  if (userPlan === "business" || userPlan === "pro") {
    return businessQueue;
  }
  return freeProQueue; // free and pro users share the same queue
};

// Export default as businessQueue for backwards compatibility (or you can export an object)
export default {
  businessQueue,
  freeProQueue,
  getQueueForUser,
};
