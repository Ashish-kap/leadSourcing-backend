import dotenv from "dotenv";
dotenv.config();
import Queue from "bull";
import scrapeJob from "../jobs/scrapeJob.js";
import Job from "../models/jobModel.js";
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
const BUSINESS_WORKERS = parseInt(process.env.BUSINESS_WORKERS) || 3; // Default: 2 workers for business
const FREE_PRO_WORKERS = parseInt(process.env.FREE_PRO_WORKERS) || 7; // Default: 1 worker for free/pro
const TOTAL_WORKERS = BUSINESS_WORKERS + FREE_PRO_WORKERS;

logger.info(
  "QUEUE_INIT",
  `Initializing queues with ${TOTAL_WORKERS} total workers: ${BUSINESS_WORKERS} business, ${FREE_PRO_WORKERS} free/pro`
);

// Shared queue settings
const queueSettings = {
  redis: redisObj,
  settings: {
    stalledInterval: 60000,
    maxStalledCount: 2,
    guardInterval: 3000,
    retryProcessDelay: 3000,
  },
  defaultJobOptions: {
    removeOnComplete: 10,
    removeOnFail: 10,
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
    const jobStatus = totalExtractions > 0 ? "completed" : "data_not_found";

    logger.info(
      "JOB_FINISHED",
      `${queueName}: Job ${job.id} finished with ${totalExtractions} records, status: ${jobStatus}`
    );

    try {
      const updatedJob = await Job.findOneAndUpdate(
        { jobId: job.data.jobId },
        {
          status: jobStatus,
          completedAt: new Date(),
          result: result,
          "progress.percentage": 100,
          "metrics.totalExtractions": totalExtractions,
        },
        { new: true }
      );

      if (updatedJob) {
        const eventType =
          jobStatus === "completed" ? "job_completed" : "job_no_data_found";

        socketService.emitJobUpdate(updatedJob.userId.toString(), eventType, {
          jobId: updatedJob.jobId,
          status: jobStatus,
          completedAt: updatedJob.completedAt,
          progress: { percentage: 100 },
          totalExtractions: totalExtractions,
          message:
            jobStatus === "data_not_found"
              ? "No data found matching your search criteria. Try adjusting your filters or location."
              : `Successfully extracted ${totalExtractions} records.`,
        });
      }
    } catch (error) {
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
      const updatedJob = await Job.findOneAndUpdate(
        { jobId: job.data.jobId },
        {
          status: "failed",
          completedAt: new Date(),
          "progress.percentage": 0,
          "metrics.totalExtractions": 0,
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
            error: {
              message: err.message,
              timestamp: new Date(),
            },
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
  if (userPlan === "business") {
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
