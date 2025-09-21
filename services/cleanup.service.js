import cron from "node-cron";
import Job from "../models/jobModel.js";
import logger from "./logger.js";

class CleanupService {
  constructor() {
    this.isRunning = false;
  }

  // Run cleanup for old jobs
  async runCleanup() {
    if (this.isRunning) {
      logger.info("CLEANUP_SKIPPED", "Previous cleanup is still running");
      return;
    }

    this.isRunning = true;
    const startTime = Date.now();

    try {
      logger.info("CLEANUP_STARTED", "Starting job cleanup process");

      const results = await Job.cleanupOldJobs();

      const duration = Date.now() - startTime;

      logger.info("CLEANUP_COMPLETED", {
        duration: `${duration}ms`,
        freePlanDeleted: results.freePlanDeleted,
        otherPlanDeleted: results.otherPlanDeleted,
        totalDeleted: results.freePlanDeleted + results.otherPlanDeleted,
        errors: results.errors.length,
      });

      if (results.errors.length > 0) {
        logger.error("CLEANUP_ERRORS", {
          errorCount: results.errors.length,
          errors: results.errors,
        });
      }
    } catch (error) {
      logger.error("CLEANUP_FAILED", {
        error: error.message,
        stack: error.stack,
      });
    } finally {
      this.isRunning = false;
    }
  }

  // Start the cleanup scheduler
  startScheduler() {
    // Run cleanup every 6 hours
    // This ensures free plan jobs are cleaned up within 24 hours
    const cronExpression = "0 */6 * * *"; // Every 6 hours

    logger.info("CLEANUP_SCHEDULER_STARTED", {
      cronExpression: cronExpression,
      description: "Job cleanup will run every 6 hours",
    });

    cron.schedule(cronExpression, () => {
      this.runCleanup();
    });

    // Run initial cleanup after 1 minute (to avoid startup conflicts)
    setTimeout(() => {
      this.runCleanup();
    }, 60000);
  }

  // Stop the cleanup scheduler
  stopScheduler() {
    cron.destroy();
    logger.info("CLEANUP_SCHEDULER_STOPPED", "Job cleanup scheduler stopped");
  }

  // Manual cleanup trigger (for testing or admin use)
  async triggerCleanup() {
    logger.info("CLEANUP_MANUAL_TRIGGER", "Manual cleanup triggered");
    await this.runCleanup();
  }
}

// Create singleton instance
const cleanupService = new CleanupService();

export default cleanupService;
