import dotenv from "dotenv";
dotenv.config();
import Queue from "bull";
import scrapeJob from "../jobs/scrapeJob.js";
import Job from "../models/jobModel.js";
import socketService from "./socket.service.js";

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

const scraperQueue = new Queue("scraper", {
  redis: redisObj,
  settings: {
    stalledInterval: 100000, // 5 minutes
    maxStalledCount: 1,
    guardInterval: 5000,
    retryProcessDelay: 5000,
  },
});

// Event handlers for job lifecycle
scraperQueue.on("error", (err) => {
  console.error("Redis connection error:", err);
});

scraperQueue.on("connected", () => {
  console.log("Successfully connected to Redis");
});

scraperQueue.on("active", async (job) => {
  console.log(`Job ${job.id} started processing`);

  // Update database record
  try {
    const updatedJob = await Job.findOneAndUpdate(
      { jobId: job.data.jobId },
      {
        status: "active",
        startedAt: new Date(),
      },
      { new: true }
    );

    // Emit socket event to user
    if (updatedJob) {
      socketService.emitJobUpdate(updatedJob.userId.toString(), "job_started", {
        jobId: updatedJob.jobId,
        status: "active",
        startedAt: updatedJob.startedAt,
        progress: updatedJob.progress,
      });
    }
  } catch (error) {
    console.error(`Error updating job ${job.id} to active:`, error);
  }
});

scraperQueue.on("progress", async (job, progress) => {
  console.log(`Job ${job.id} progress:`, progress);

  // Update database with progress
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

    // Emit socket event to user for progress update
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
    console.error(`Error updating job ${job.id} progress:`, error);
  }
});

scraperQueue.on("completed", async (job, result) => {
  console.log(`Job ${job.id} completed`);

  // Update database record
  try {
    const updatedJob = await Job.findOneAndUpdate(
      { jobId: job.data.jobId },
      {
        status: "completed",
        completedAt: new Date(),
        result: result,
        "progress.percentage": 100,
        "metrics.totalExtractions": result?.length || 0,
      },
      { new: true }
    );

    // Emit socket event to user for job completion
    if (updatedJob) {
      socketService.emitJobUpdate(
        updatedJob.userId.toString(),
        "job_completed",
        {
          jobId: updatedJob.jobId,
          status: "completed",
          completedAt: updatedJob.completedAt,
          progress: { percentage: 100 },
          totalExtractions: result?.length || 0,
        }
      );
    }
  } catch (error) {
    console.error(`Error updating completed job ${job.id}:`, error);
  }
});

scraperQueue.on("failed", async (job, err) => {
  console.error(`Job ${job.id} failed:`, err.message);

  // Update database record
  try {
    const updatedJob = await Job.findOneAndUpdate(
      { jobId: job.data.jobId },
      {
        status: "failed",
        completedAt: new Date(),
        error: {
          message: err.message,
          stack: err.stack,
          timestamp: new Date(),
        },
      },
      { new: true }
    );

    // Emit socket event to user for job failure
    if (updatedJob) {
      socketService.emitJobUpdate(updatedJob.userId.toString(), "job_failed", {
        jobId: updatedJob.jobId,
        status: "failed",
        completedAt: updatedJob.completedAt,
        error: {
          message: err.message,
          timestamp: new Date(),
        },
      });
    }
  } catch (error) {
    console.error(`Error updating failed job ${job.id}:`, error);
  }
});

// Process with configurable concurrent workers
const CONCURRENT_WORKERS = parseInt(process.env.CONCURRENT_WORKERS) || 3;
scraperQueue.process(CONCURRENT_WORKERS, scrapeJob);

export default scraperQueue;
