// import { runScraper } from "../services/scraper4.service.js";
// import * as authController from "./../api/controllers/authController.js";


// export default async function (job) {
//   try {
//     // Initialize progress with object format
//     await job.progress(0);
//     const result = await runScraper(job.data, job);
//     return result;
//   } catch (error) {
//     await job.progress(100, { error: error.message });
//     throw error;
//   }
// }


import { runScraper } from "../services/scraper4.service.js";
import Job from "../models/jobModel.js";

export default async function (job) {
  try {
    // Initialize progress
    await job.progress(0);

    // Update database job status
    const dbJob = await Job.findOne({ jobId: job.data.jobId });
    if (dbJob) {
      await dbJob.updateStatus("active");
    }

    // Run the scraper with progress updates
    const result = await runScraper(job.data, job);

    // Final progress update
    await job.progress(100);

    return result;
  } catch (error) {
    await job.progress(100, { error: error.message });

    // Update database with error
    const dbJob = await Job.findOne({ jobId: job.data.jobId });
    if (dbJob) {
      await dbJob.updateStatus("failed", {
        error: {
          message: error.message,
          stack: error.stack,
          timestamp: new Date(),
        },
      });
    }

    throw error;
  }
}
