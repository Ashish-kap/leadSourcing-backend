import Queue from "bull";
import scrapeJob from "../jobs/scrapeJob.js";

const scraperQueue = new Queue("scraper", {
  // redis: { host: "localhost", port: 6379 },
  // redis: {
  //   url: process.env.REDIS_URL,
  // },
  redis: {
    username: "default",
    password: "a2kXd1WR3sml2pfDvpDAsYgnFDWbca1t",
    host: "redis-14751.c323.us-east-1-2.ec2.redns.redis-cloud.com",
    port: 14751,
    tls: {
      rejectUnauthorized: false,
    }, 
  },
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
