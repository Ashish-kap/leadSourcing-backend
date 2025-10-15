import cron from "node-schedule";
import creditsService from "../services/credits.service.js";
import logger from "../services/logger.js";

class CreditsJob {
  constructor() {
    this.jobs = new Map();
  }

  /**
   * Initialize all credit-related cron jobs
   */
  init() {
    this.scheduleDailyCreditsAllocation();
    this.scheduleDailyReset();
    logger.info("CREDITS_JOBS_INITIALIZED");
  }

  /**
   * Schedule daily credits allocation for subscription anniversaries
   * Runs every day at 00:00 to check for subscription anniversaries
   */
  scheduleDailyCreditsAllocation() {
    const job = cron.scheduleJob("0 0 * * *", async () => {
      try {
        logger.info("CREDITS_DAILY_ALLOCATION_STARTED");

        const results = await creditsService.allocateMonthlyCredits();

        logger.info("CREDITS_DAILY_ALLOCATION_COMPLETED", {
          allocated: results.successful,
          failed: results.failed,
        });
      } catch (error) {
        logger.error("CREDITS_DAILY_ALLOCATION_JOB_ERROR", {
          error: error.message,
        });
      }
    });

    this.jobs.set("dailyAllocation", job);
    logger.info("CREDITS_DAILY_ALLOCATION_JOB_SCHEDULED");
  }

  /**
   * Schedule daily reset for users who received credits
   * Runs every day at 00:05 (5 minutes after allocation)
   */
  scheduleDailyReset() {
    const job = cron.scheduleJob("5 0 * * *", async () => {
      try {
        logger.info("CREDITS_DAILY_RESET_STARTED");

        const result = await creditsService.resetMonthlyAllocation();

        logger.info("CREDITS_DAILY_RESET_COMPLETED", {
          modifiedCount: result.modifiedCount,
        });
      } catch (error) {
        logger.error("CREDITS_DAILY_RESET_JOB_ERROR", {
          error: error.message,
        });
      }
    });

    this.jobs.set("dailyReset", job);
    logger.info("CREDITS_DAILY_RESET_JOB_SCHEDULED");
  }

  /**
   * Manually trigger monthly credits allocation (for testing/admin use)
   */
  async triggerMonthlyAllocation() {
    try {
      logger.info("CREDITS_MANUAL_MONTHLY_ALLOCATION_TRIGGERED");
      const results = await creditsService.allocateMonthlyCredits();

      logger.info("CREDITS_MANUAL_MONTHLY_ALLOCATION_COMPLETED", {
        allocated: results.successful,
        failed: results.failed,
      });

      return results;
    } catch (error) {
      logger.error("CREDITS_MANUAL_MONTHLY_ALLOCATION_ERROR", {
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Manually trigger monthly reset (for testing/admin use)
   */
  async triggerMonthlyReset() {
    try {
      logger.info("CREDITS_MANUAL_MONTHLY_RESET_TRIGGERED");
      const result = await creditsService.resetMonthlyAllocation();

      logger.info("CREDITS_MANUAL_MONTHLY_RESET_COMPLETED", {
        modifiedCount: result.modifiedCount,
      });

      return result;
    } catch (error) {
      logger.error("CREDITS_MANUAL_MONTHLY_RESET_ERROR", {
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Get status of all scheduled jobs
   */
  getJobStatus() {
    const status = {};

    for (const [name, job] of this.jobs) {
      status[name] = {
        scheduled: job !== null,
        nextInvocation: job?.nextInvocation() || null,
      };
    }

    return status;
  }

  /**
   * Cancel all scheduled jobs
   */
  cancelAllJobs() {
    for (const [name, job] of this.jobs) {
      if (job) {
        job.cancel();
        logger.info("CREDITS_JOB_CANCELLED", { jobName: name });
      }
    }
    this.jobs.clear();
  }

  /**
   * Cancel a specific job
   * @param {string} jobName - Name of the job to cancel
   */
  cancelJob(jobName) {
    const job = this.jobs.get(jobName);
    if (job) {
      job.cancel();
      this.jobs.delete(jobName);
      logger.info("CREDITS_JOB_CANCELLED", { jobName });
      return true;
    }
    return false;
  }
}

// Export singleton instance
const creditsJob = new CreditsJob();
export default creditsJob;
