// import dotenv from "dotenv";
// dotenv.config();
// import Queue from "bull";
// import scrapeJob from "../jobs/scrapeJob.js";
// import { URL } from "url";

// const redisUrl = process.env.REDIS_HOST
//   ? new URL(process.env.REDIS_HOST)
//   : undefined;
// // console.log("redisUrl", redisUrl);
// const redisObj = process.env.REDIS_HOST
//   ? {
//       // host: process.env.REDIS_URL || "localhost",
//       // port: 6379,
//       host: redisUrl.hostname,
//       port: redisUrl.port,
//       password: redisUrl.password.replace("default:", ""),
//     }
//   : {
//       host: "localhost",
//       port: 6379,
//     };


//   console.log(redisObj)
// const scraperQueue = new Queue("scraper", {
//   // redis: {
//   //   // host: process.env.REDIS_URL || "localhost",
//   //   // port: 6379,
//   //   host: redisUrl.hostname,
//   //   port: redisUrl.port,
//   //   password: redisUrl.password.replace("default:", ""),
//   // },
//   redis: redisObj,
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

// // Process with 3 concurrent workers
// scraperQueue.process(1, scrapeJob);

// export default scraperQueue;


import dotenv from "dotenv";
dotenv.config();
import Queue from "bull";
import scrapeJob from "../jobs/scrapeJob.js";

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

scraperQueue.on("error", (err) => {
  console.error("Redis connection error:", err);
});

scraperQueue.on("connected", () => {
  console.log("Successfully connected to Redis");
});

// Process with 1 concurrent worker
scraperQueue.process(1, scrapeJob);

export default scraperQueue;

