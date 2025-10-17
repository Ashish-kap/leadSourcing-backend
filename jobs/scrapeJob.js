import { runScraper } from "../services/scraper3.service.js";
import Job from "../models/jobModel.js";
import User from "../models/userModel.js";

export default async function (job) {
  try {
    // Initialize progress
    await job.progress(0);

    // Update database job status
    const dbJob = await Job.findOne({ jobId: job.data.jobId });

    // Check if job was cancelled before we even started
    if (!dbJob || dbJob.status === "failed") {
      console.log(`Job ${job.data.jobId} was cancelled before starting`);
      throw new Error("Job was cancelled before execution");
    }

    if (dbJob) {
      await dbJob.updateStatus("active");
    }

    // Run the scraper with progress updates
    const result = await runScraper(job.data, job);

    // Final progress update emitted inside runScraper after cleanup

    // Update database job status based on results
    const finalDbJob = await Job.findOne({ jobId: job.data.jobId });

    // Only update if job still exists and wasn't cancelled
    if (finalDbJob && finalDbJob.status !== "failed") {
      // Get user to check plan for credit calculation
      const user = await User.findById(job.data.userId);
      const actualCreditsUsed =
        user && user.hasUnlimitedExtraction()
          ? 0
          : Math.ceil((result?.length || 0) / 10) * 10;

      // Determine status based on results and current job status
      const totalExtractions = result?.length || 0;
      let jobStatus;
      
      // If job was marked as stuck_timeout, keep that status
      if (finalDbJob.status === "stuck_timeout") {
        jobStatus = "stuck_timeout";
        logger.info(`Job ${job.data.jobId} completed with stuck timeout status - returning partial results`);
      } else {
        jobStatus = totalExtractions > 0 ? "completed" : "data_not_found";
      }

      await finalDbJob.updateStatus(jobStatus, {
        result: result,
        metrics: {
          totalExtractions: totalExtractions,
          dataPointsCollected: totalExtractions,
          creditsUsed: actualCreditsUsed,
          planType: user?.plan || "unknown",
        },
      });
    } else if (!finalDbJob) {
      console.log(`Job ${job.data.jobId} was deleted before completion update`);
    } else {
      console.log(
        `Job ${job.data.jobId} was cancelled, skipping completion update`
      );
    }

    return result;
  } catch (error) {
    // Gracefully handle progress update errors (job might be cancelled)
    try {
      await job.progress(100, { error: error.message });
    } catch (progressError) {
      console.log(
        `Could not update progress for job ${job.data.jobId}: ${progressError.message}`
      );
    }

    // Update database with error only if job still exists and not already failed
    const dbJob = await Job.findOne({ jobId: job.data.jobId });
    if (dbJob && dbJob.status !== "failed") {
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
