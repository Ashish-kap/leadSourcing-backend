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
import User from "../models/userModel.js";

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

    // Update database job status to completed
    if (dbJob) {
      // Get user to check plan for credit calculation
      const user = await User.findById(job.data.userId);
      const actualCreditsUsed =
        user && user.hasUnlimitedAccess()
          ? 0
          : Math.ceil((result?.length || 0) / 10) * 10;

      await dbJob.updateStatus("completed", {
        result: result,
        metrics: {
          totalExtractions: result?.length || 0,
          dataPointsCollected: result?.length || 0,
          creditsUsed: actualCreditsUsed,
          planType: user?.plan || "unknown", // Track plan type for analytics
        },
      });
    }

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
