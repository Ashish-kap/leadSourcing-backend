
import Queue from "bull";
import scrapeJob from "../jobs/scrapeJob.js";

const scraperQueue = new Queue("scraper", {
  redis: { host: "localhost", port: 6379 },
  settings: {
    stalledInterval: 300000, // 5 minutes
    maxStalledCount: 2,
    guardInterval: 5000,
    retryProcessDelay: 5000
  }
});

// Process with 3 concurrent workers
scraperQueue.process(3, scrapeJob);

export default scraperQueue;