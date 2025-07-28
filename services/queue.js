import dotenv from "dotenv";
dotenv.config();
import Queue from "bull";
import scrapeJob from "../jobs/scrapeJob.js";
import { URL } from "url";


console.log("redisUrl",redisUrl)

const redisUrl = new URL(process.env.REDIS_HOST || "redis://localhost:6379");
const scraperQueue = new Queue("scraper", {
  redis: {
    // host: process.env.REDIS_URL || "localhost",
    // port: 6379,
    host: redisUrl.hostname,
    port: redisUrl.port,
    password: redisUrl.password.replace("default:", ""), 
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
scraperQueue.process(1, scrapeJob);

export default scraperQueue;
