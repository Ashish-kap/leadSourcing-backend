import Queue from "bull";
import scrapeJob from "../jobs/scrapeJob.js";

const scraperQueue = new Queue("scraper", {
  redis: { host: "localhost", port: 6379 },
  // redis: {
  //   url: process.env.REDIS_URL,
  //   tls: { rejectUnauthorized: false },
  // },
  // redis: process.env.REDIS_URL,
  settings: {
    stalledInterval: 300000, // 5 minutes
    maxStalledCount: 2,
    guardInterval: 5000,
    retryProcessDelay: 5000,
  },
});

scraperQueue.on("error", (err) => {
  console.error("Redis connection error:", err);
});

scraperQueue.on("connected", () => {
  console.log("Successfully connected to Redis");
});

// Process with 3 concurrent workers
scraperQueue.process(3, scrapeJob);

export default scraperQueue;
