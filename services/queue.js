// import dotenv from "dotenv";
// dotenv.config();
// import Queue from "bull";
// import scrapeJob from "../jobs/scrapeJob.js";

// let redisObj;

// if (process.env.REDIS_HOST) {
//   try {
//     const redisUrl = new URL(process.env.REDIS_HOST);
//     redisObj = {
//       host: redisUrl.hostname,
//       port: parseInt(redisUrl.port, 10) || 6379,
//       password: redisUrl.password
//         ? redisUrl.password.replace(/^default:/, "")
//         : undefined,
//     };
//   } catch (e) {
//     redisObj = {
//       host: process.env.REDIS_HOST,
//       port: 6379,
//     };
//   }
// } else {
//   redisObj = {
//     host: "localhost",
//     port: 6379,
//   };
// }

// const scraperQueue = new Queue("scraper", {
//   redis: redisObj,
//   // redis:{
//   //   host: "localhost",
//   //   port: 6379,
//   // },
//   settings: {
//     stalledInterval: 300000, // 5 minutes
//     maxStalledCount: 2,
//     guardInterval: 5000,
//     retryProcessDelay: 5000,
//   },
// });

// scraperQueue.on("error", (err) => {
//   console.error("Redis connection error:", err);
// });

// scraperQueue.on("connected", () => {
//   console.log("Successfully connected to Redis");
// });

// scraperQueue.on("progress", (job, progress) => {
//   console.log(`Job ${job.id} progress:`, progress);
// });

// scraperQueue.process(2, scrapeJob);

// export default scraperQueue;



import dotenv from "dotenv";
dotenv.config();
import Queue from "bull";
import scrapeJob from "../jobs/scrapeJob.js";
import Job from "../models/jobModel.js";

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
    stalledInterval: 300000, // 5 minutes
    maxStalledCount: 2,
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
    await Job.findOneAndUpdate(
      { jobId: job.data.jobId },
      {
        status: "active",
        startedAt: new Date(),
      }
    );
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

    await Job.findOneAndUpdate({ jobId: job.data.jobId }, updateData);
  } catch (error) {
    console.error(`Error updating job ${job.id} progress:`, error);
  }
});

scraperQueue.on("completed", async (job, result) => {
  console.log(`Job ${job.id} completed`);

  // Update database record
  try {
    await Job.findOneAndUpdate(
      { jobId: job.data.jobId },
      {
        status: "completed",
        completedAt: new Date(),
        result: result,
        "progress.percentage": 100,
        "metrics.totalExtractions": result?.length || 0,
      }
    );
  } catch (error) {
    console.error(`Error updating completed job ${job.id}:`, error);
  }
});

scraperQueue.on("failed", async (job, err) => {
  console.error(`Job ${job.id} failed:`, err.message);

  // Update database record
  try {
    await Job.findOneAndUpdate(
      { jobId: job.data.jobId },
      {
        status: "failed",
        completedAt: new Date(),
        error: {
          message: err.message,
          stack: err.stack,
          timestamp: new Date(),
        },
      }
    );
  } catch (error) {
    console.error(`Error updating failed job ${job.id}:`, error);
  }
});

// Process with 1 concurrent worker
scraperQueue.process(1, scrapeJob);

export default scraperQueue;
