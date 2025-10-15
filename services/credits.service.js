import User from "../models/userModel.js";
import logger from "./logger.js";

class CreditsService {
  constructor() {
    // Credit allocation amounts by plan
    this.creditAllocations = {
      free: 500,
      pro: 10000,
      business: 100000,
    };
  }

  /**
   * Get credit allocation amount for a plan
   * @param {string} plan - User plan (free, pro, business)
   * @returns {number} Credit amount to allocate
   */
  getCreditAllocation(plan) {
    return this.creditAllocations[plan] || 0;
  }

  /**
   * Allocate credits to a user based on their plan
   * @param {string} userId - User ID
   * @param {string} reason - Reason for allocation (payment, monthly, etc.)
   * @returns {Promise<Object>} Updated user object
   */
  async allocateCredits(userId, reason = "manual") {
    try {
      const user = await User.findById(userId);
      if (!user) {
        throw new Error("User not found");
      }

      const creditAmount = this.getCreditAllocation(user.plan);

      if (creditAmount === 0) {
        logger.info("CREDITS_NO_ALLOCATION", {
          userId,
          plan: user.plan,
          reason,
        });
        return user;
      }

      // Reset credits to plan amount (don't carry forward)
      const oldTotal = user.credits.total;
      const oldRemaining = user.credits.remaining;

      user.credits.total = creditAmount;
      user.credits.remaining = creditAmount;
      user.credits.used = 0; // Reset used credits
      user.credits.lastAllocated = new Date();

      // Mark as monthly allocated for all users
      user.credits.monthlyAllocated = true;

      await user.save({ validateBeforeSave: false });

      logger.info("CREDITS_ALLOCATED", {
        userId,
        plan: user.plan,
        creditAmount,
        oldTotal,
        oldRemaining,
        newTotal: user.credits.total,
        newRemaining: user.credits.remaining,
        reason,
      });

      return user;
    } catch (error) {
      logger.error("CREDITS_ALLOCATION_ERROR", {
        userId,
        error: error.message,
        reason,
      });
      throw error;
    }
  }

  /**
   * Allocate credits to multiple users (for batch operations)
   * @param {Array} userIds - Array of user IDs
   * @param {string} reason - Reason for allocation
   * @returns {Promise<Object>} Results summary
   */
  async allocateCreditsBatch(userIds, reason = "batch") {
    const results = {
      successful: 0,
      failed: 0,
      errors: [],
    };

    for (const userId of userIds) {
      try {
        await this.allocateCredits(userId, reason);
        results.successful++;
      } catch (error) {
        results.failed++;
        results.errors.push({
          userId,
          error: error.message,
        });
      }
    }

    logger.info("CREDITS_BATCH_ALLOCATION", {
      total: userIds.length,
      successful: results.successful,
      failed: results.failed,
      reason,
    });

    return results;
  }

  /**
   * Reset monthly allocation flag for all users (called by cron job)
   * @returns {Promise<Object>} Reset results
   */
  async resetMonthlyAllocation() {
    try {
      const result = await User.updateMany(
        {
          "credits.monthlyAllocated": true,
        },
        {
          $set: { "credits.monthlyAllocated": false },
        }
      );

      logger.info("CREDITS_MONTHLY_RESET", {
        modifiedCount: result.modifiedCount,
      });

      return result;
    } catch (error) {
      logger.error("CREDITS_MONTHLY_RESET_ERROR", {
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Allocate monthly credits to users based on subscription anniversary
   * @returns {Promise<Object>} Allocation results
   */
  async allocateMonthlyCredits() {
    try {
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const oneMonthAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);

      // Find users who need monthly credits
      const usersNeedingCredits = await User.find({
        "credits.monthlyAllocated": false,
        $or: [
          // Free users get credits on 1st of every month (calendar-based)
          {
            plan: "free",
            $expr: {
              $eq: [{ $dayOfMonth: "$createdAt" }, 1],
            },
          },
          // Paid users get credits based on subscription anniversary (30 days after last allocation)
          {
            plan: "pro",
            "subscription.status": "active",
            "credits.lastAllocated": { $lte: oneMonthAgo },
          },
          {
            plan: "business",
            "subscription.status": "active",
            "credits.lastAllocated": { $lte: oneMonthAgo },
          },
        ],
      });

      if (usersNeedingCredits.length === 0) {
        logger.info("CREDITS_NO_MONTHLY_ALLOCATION_NEEDED");
        return { allocated: 0, users: [] };
      }

      const userIds = usersNeedingCredits.map((user) => user._id.toString());
      const results = await this.allocateCreditsBatch(userIds, "monthly");

      logger.info("CREDITS_MONTHLY_ALLOCATION_COMPLETE", {
        totalUsers: usersNeedingCredits.length,
        successful: results.successful,
        failed: results.failed,
        planBreakdown: {
          free: usersNeedingCredits.filter((u) => u.plan === "free").length,
          pro: usersNeedingCredits.filter((u) => u.plan === "pro").length,
          business: usersNeedingCredits.filter((u) => u.plan === "business")
            .length,
        },
      });

      return results;
    } catch (error) {
      logger.error("CREDITS_MONTHLY_ALLOCATION_ERROR", {
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Get user credit status
   * @param {string} userId - User ID
   * @returns {Promise<Object>} User credit information
   */
  async getUserCreditStatus(userId) {
    try {
      const user = await User.findById(userId).select("plan credits");
      if (!user) {
        throw new Error("User not found");
      }

      return {
        plan: user.plan,
        credits: {
          total: user.credits.total,
          used: user.credits.used,
          remaining: user.credits.remaining,
          percentage: user.creditPercentage,
          lastAllocated: user.credits.lastAllocated,
          monthlyAllocated: user.credits.monthlyAllocated,
        },
        hasUnlimitedAccess: user.hasUnlimitedAccess(),
        hasUnlimitedExtraction: user.hasUnlimitedExtraction(),
      };
    } catch (error) {
      logger.error("CREDITS_STATUS_ERROR", {
        userId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Check if user has sufficient credits for an operation
   * @param {string} userId - User ID
   * @param {number} requiredCredits - Credits required for operation
   * @returns {Promise<Object>} Credit check result
   */
  async checkCredits(userId, requiredCredits) {
    try {
      const user = await User.findById(userId);
      if (!user) {
        throw new Error("User not found");
      }

      // Business plan users have unlimited credits
      if (user.hasUnlimitedExtraction()) {
        return {
          hasCredits: true,
          remaining: "unlimited",
          plan: user.plan,
        };
      }

      const hasCredits = user.credits.remaining >= requiredCredits;

      return {
        hasCredits,
        remaining: user.credits.remaining,
        required: requiredCredits,
        plan: user.plan,
      };
    } catch (error) {
      logger.error("CREDITS_CHECK_ERROR", {
        userId,
        requiredCredits,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Deduct credits from user (wrapper around user method)
   * @param {string} userId - User ID
   * @param {number} amount - Amount to deduct
   * @returns {Promise<Object>} Updated user
   */
  async deductCredits(userId, amount) {
    try {
      const user = await User.findById(userId);
      if (!user) {
        throw new Error("User not found");
      }

      const updatedUser = await user.deductCredits(amount);

      logger.info("CREDITS_DEDUCTED", {
        userId,
        amount,
        remaining: updatedUser.credits.remaining,
        plan: user.plan,
      });

      return updatedUser;
    } catch (error) {
      logger.error("CREDITS_DEDUCTION_ERROR", {
        userId,
        amount,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Refund credits to user (wrapper around user method)
   * @param {string} userId - User ID
   * @param {number} amount - Amount to refund
   * @returns {Promise<Object>} Updated user
   */
  async refundCredits(userId, amount) {
    try {
      const user = await User.findById(userId);
      if (!user) {
        throw new Error("User not found");
      }

      const updatedUser = await user.refundCredits(amount);

      logger.info("CREDITS_REFUNDED", {
        userId,
        amount,
        remaining: updatedUser.credits.remaining,
        plan: user.plan,
      });

      return updatedUser;
    } catch (error) {
      logger.error("CREDITS_REFUND_ERROR", {
        userId,
        amount,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Downgrade user to free plan and reset credits
   * @param {string} userId - User ID
   * @param {string} reason - Reason for downgrade (cancellation, expiration, etc.)
   * @returns {Promise<Object>} Updated user
   */
  async downgradeToFreePlan(userId, reason = "subscription_ended") {
    try {
      const user = await User.findById(userId);
      if (!user) {
        throw new Error("User not found");
      }

      const oldPlan = user.plan;
      const oldCredits = {
        total: user.credits.total,
        used: user.credits.used,
        remaining: user.credits.remaining,
      };

      // Downgrade to free plan
      user.plan = "free";

      // Reset credits to free plan amount
      const freeCredits = this.getCreditAllocation("free");
      user.credits.total = freeCredits;
      user.credits.remaining = freeCredits;
      user.credits.used = 0;
      user.credits.lastAllocated = new Date();
      user.credits.monthlyAllocated = false;

      // Clear subscription details
      user.subscription = {
        subscriptionId: null,
        status: null,
        nextBillingDate: null,
        previousBillingDate: null,
        paymentFrequencyCount: null,
        paymentFrequencyInterval: null,
        subscriptionPeriodCount: null,
        subscriptionPeriodInterval: null,
        payloadType: null,
      };

      await user.save({ validateBeforeSave: false });

      logger.info("USER_DOWNGRADED_TO_FREE", {
        userId,
        oldPlan,
        newPlan: "free",
        oldCredits,
        newCredits: {
          total: user.credits.total,
          used: user.credits.used,
          remaining: user.credits.remaining,
        },
        reason,
      });

      return user;
    } catch (error) {
      logger.error("USER_DOWNGRADE_ERROR", {
        userId,
        error: error.message,
        reason,
      });
      throw error;
    }
  }

  /**
   * Handle subscription status changes
   * @param {string} userId - User ID
   * @param {string} newStatus - New subscription status
   * @param {string} reason - Reason for status change
   * @returns {Promise<Object>} Updated user
   */
  async handleSubscriptionStatusChange(
    userId,
    newStatus,
    reason = "status_change"
  ) {
    try {
      const user = await User.findById(userId);
      if (!user) {
        throw new Error("User not found");
      }

      // Update subscription status
      if (user.subscription) {
        user.subscription.status = newStatus;
      }

      // If subscription is cancelled, expired, or failed, downgrade to free
      if (["cancelled", "expired", "failed"].includes(newStatus)) {
        return await this.downgradeToFreePlan(userId, reason);
      }

      await user.save({ validateBeforeSave: false });

      logger.info("SUBSCRIPTION_STATUS_UPDATED", {
        userId,
        plan: user.plan,
        newStatus,
        reason,
      });

      return user;
    } catch (error) {
      logger.error("SUBSCRIPTION_STATUS_UPDATE_ERROR", {
        userId,
        newStatus,
        error: error.message,
        reason,
      });
      throw error;
    }
  }
}

// Export singleton instance
const creditsService = new CreditsService();
export default creditsService;
