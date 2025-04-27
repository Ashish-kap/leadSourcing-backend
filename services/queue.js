import Queue from "bull";
import scrapeJob from "../jobs/scrapeJob.js";

const scraperQueue = new Queue("scraper", {
  // redis: { host: "localhost", port: 6379 },
  // redis: {
  //   url: process.env.REDIS_URL,
  //   tls: {
  //     rejectUnauthorized: false,
  //   },
  // },
  redis: {
    // host: process.env.REDIS_HOST || "redis.railway.internal",
    // port: parseInt(process.env.REDIS_PORT) || 6379,
    // password: process.env.REDIS_PASSWORD || "sOIBUPgdiXNvtYknQhWudMAQCFZwlvsA",
    host: "redis.railway.internal",
    port: 6379,
    password: "sOIBUPgdiXNvtYknQhWudMAQCFZwlvsA",
  },
  settings: {
    stalledInterval: 300000, // 5 minutes
    maxStalledCount: 2,
    guardInterval: 5000,
    retryProcessDelay: 5000,
  },
});

// Process with 3 concurrent workers
scraperQueue.process(1, scrapeJob);

export default scraperQueue;
