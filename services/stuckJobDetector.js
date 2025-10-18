import logger from "./logger.js";

// Stuck job detection configuration
// Environment variables for stuck job detection:
// STUCK_RECORDS_TIMEOUT_MS - Time to wait before considering job stuck on records count (default: 600000ms = 10 minutes)
// STUCK_PERCENTAGE_TIMEOUT_MS - Time to wait before considering job stuck on percentage (default: 300000ms = 5 minutes)  
// STUCK_JOB_GRACE_PERIOD_MS - Grace period before force termination after stuck detection (default: 30000ms = 30 seconds)
const STUCK_RECORDS_TIMEOUT_MS = Number(process.env.STUCK_RECORDS_TIMEOUT_MS || 600000); // 10 minutes
const STUCK_PERCENTAGE_TIMEOUT_MS = Number(process.env.STUCK_PERCENTAGE_TIMEOUT_MS || 300000); // 5 minutes
const STUCK_JOB_GRACE_PERIOD_MS = Number(process.env.STUCK_JOB_GRACE_PERIOD_MS || 30000); // 30 seconds

/**
 * ProgressMonitor class to track job progress and detect stuck jobs
 */
class ProgressMonitor {
  constructor(jobId) {
    this.jobId = jobId;
    this.lastRecordsCount = 0;
    this.lastPercentage = 0;
    this.lastRecordsUpdate = Date.now();
    this.lastPercentageUpdate = Date.now();
    this.isStuck = false;
    this.stuckReason = null;
    this.stuckAt = null;
  }

  /**
   * Update progress and check for stuck conditions
   * @param {number} recordsCount - Current number of records collected
   * @param {number} percentage - Current percentage progress
   * @returns {Object} - { isStuck: boolean, reason: string|null, stuckFor: number }
   */
  updateProgress(recordsCount, percentage) {
    const now = Date.now();
    
    // Check if records count has changed
    const recordsChanged = recordsCount !== this.lastRecordsCount;
    if (recordsChanged) {
      this.lastRecordsCount = recordsCount;
      this.lastRecordsUpdate = now;
    }
    
    // Check if percentage has changed
    const percentageChanged = percentage !== this.lastPercentage;
    if (percentageChanged) {
      this.lastPercentage = percentage;
      this.lastPercentageUpdate = now;
    }
    
    // Calculate how long each metric has been stuck
    const recordsStuckFor = now - this.lastRecordsUpdate;
    const percentageStuckFor = now - this.lastPercentageUpdate;
    
    // Check for stuck conditions
    const recordsStuck = recordsStuckFor > STUCK_RECORDS_TIMEOUT_MS;
    const percentageStuck = percentageStuckFor > STUCK_PERCENTAGE_TIMEOUT_MS;
    
    if (recordsStuck || percentageStuck) {
      if (!this.isStuck) {
        this.isStuck = true;
        this.stuckAt = now;
        this.stuckReason = recordsStuck ? 'records' : 'percentage';
        
        logger.warn(
          "JOB_STUCK_DETECTED",
          `Job ${this.jobId} detected as stuck`,
          {
            reason: this.stuckReason,
            recordsCount: this.lastRecordsCount,
            percentage: this.lastPercentage,
            recordsStuckFor: Math.round(recordsStuckFor / 1000),
            percentageStuckFor: Math.round(percentageStuckFor / 1000),
            thresholds: {
              recordsTimeout: Math.round(STUCK_RECORDS_TIMEOUT_MS / 1000),
              percentageTimeout: Math.round(STUCK_PERCENTAGE_TIMEOUT_MS / 1000),
            }
          }
        );
      }
      
      return {
        isStuck: true,
        reason: this.stuckReason,
        stuckFor: this.stuckReason === 'records' ? recordsStuckFor : percentageStuckFor,
        recordsStuckFor,
        percentageStuckFor
      };
    }
    
    return {
      isStuck: false,
      reason: null,
      stuckFor: 0,
      recordsStuckFor,
      percentageStuckFor
    };
  }
  
  /**
   * Get current stuck detection status
   */
  getStatus() {
    return {
      isStuck: this.isStuck,
      reason: this.stuckReason,
      stuckAt: this.stuckAt,
      lastRecordsCount: this.lastRecordsCount,
      lastPercentage: this.lastPercentage,
      lastRecordsUpdate: this.lastRecordsUpdate,
      lastPercentageUpdate: this.lastPercentageUpdate
    };
  }
}

/**
 * Get stuck job detection configuration
 */
export const getStuckJobConfig = () => ({
  STUCK_RECORDS_TIMEOUT_MS,
  STUCK_PERCENTAGE_TIMEOUT_MS,
  STUCK_JOB_GRACE_PERIOD_MS,
});

export { ProgressMonitor };
export default ProgressMonitor;
