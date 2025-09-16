import { runScraper } from "../services/scraper6.service.js";
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

    // Final progress update emitted inside runScraper after cleanup

    // Update database job status based on results
    if (dbJob) {
      // Get user to check plan for credit calculation
      const user = await User.findById(job.data.userId);
      const actualCreditsUsed =
        user && user.hasUnlimitedExtraction()
          ? 0
          : Math.ceil((result?.length || 0) / 10) * 10;

      // Determine status based on results
      const totalExtractions = result?.length || 0;
      const jobStatus = totalExtractions > 0 ? "completed" : "data_not_found";

      await dbJob.updateStatus(jobStatus, {
        result: result,
        metrics: {
          totalExtractions: totalExtractions,
          dataPointsCollected: totalExtractions,
          creditsUsed: actualCreditsUsed,
          planType: user?.plan || "unknown",
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
