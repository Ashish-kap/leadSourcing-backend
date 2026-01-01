import User from "../../models/userModel.js";
import catchAsync from "../../utils/catchAsync.js";
import AppError from "../../utils/appError.js";
import mongoose from "mongoose";

/**
 * Mask name for privacy (shows first letter and last letter, masks middle)
 * Example: "John Doe" -> "J***e"
 */
const maskName = (name) => {
  if (!name) return null;
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0) return null;
  
  // Mask each part
  const maskedParts = parts.map((part) => {
    if (part.length <= 2) return part[0] + "*";
    return part[0] + "*".repeat(Math.min(part.length - 2, 3)) + part[part.length - 1];
  });
  
  return maskedParts.join(" ");
};

/**
 * Mask email for privacy (shows first 2 chars of local part and first char of domain, masks rest)
 * Example: "john.doe@example.com" -> "jo***@e***.com"
 */
const maskEmail = (email) => {
  if (!email) return null;
  const [localPart, fullDomain] = email.split("@");
  if (!fullDomain) return email; // Invalid email format
  
  // Mask local part
  let maskedLocal;
  if (localPart.length <= 2) {
    maskedLocal = localPart[0] + "*";
  } else {
    const visibleChars = Math.min(2, localPart.length);
    maskedLocal = localPart.substring(0, visibleChars) + "***";
  }
  
  // Split domain into domain name and TLD
  const lastDotIndex = fullDomain.lastIndexOf(".");
  if (lastDotIndex === -1) {
    // No TLD found, mask entire domain
    const domainName = fullDomain;
    if (domainName.length <= 1) {
      return maskedLocal + "@" + domainName;
    }
    return maskedLocal + "@" + domainName[0] + "***";
  }
  
  const domainName = fullDomain.substring(0, lastDotIndex);
  const tld = fullDomain.substring(lastDotIndex + 1);
  
  // Mask domain name but keep TLD visible
  let maskedDomain;
  if (domainName.length <= 1) {
    maskedDomain = domainName + "***";
  } else {
    maskedDomain = domainName[0] + "***";
  }
  
  return maskedLocal + "@" + maskedDomain + "." + tld;
};

/**
 * Get affiliate dashboard for the logged-in user
 * GET /api/v1/affiliate/me
 * Returns counts of free/paid referrals and list of paid referrals with payout status
 */
export const getAffiliateDashboard = catchAsync(async (req, res, next) => {
  const referrerId = req.user.id;

  // Aggregation to get counts
  const countsResult = await User.aggregate([
    {
      // Match all users referred by this user
      $match: {
        referredBy: new mongoose.Types.ObjectId(referrerId),
        active: { $ne: false },
      },
    },
    {
      // Add computed field to determine if user is a paid qualified referral
      $addFields: {
        isPaidQualified: {
          $and: [
            { $in: ["$plan", ["pro", "business"]] },
            { $eq: ["$subscription.status", "active"] },
          ],
        },
      },
    },
    {
      // Group to calculate counts
      $group: {
        _id: null,
        freeTrialCount: {
          $sum: {
            $cond: [{ $eq: ["$isPaidQualified", false] }, 1, 0],
          },
        },
        paidPlansCount: {
          $sum: {
            $cond: ["$isPaidQualified", 1, 0],
          },
        },
        paidPlansPaidCount: {
          $sum: {
            $cond: [
              {
                $and: [
                  "$isPaidQualified",
                  {
                    $or: [
                      { $eq: [{ $ifNull: ["$referralPayout.paid", false] }, true] },
                      { $ne: [{ $ifNull: ["$referralPayout.paidAt", null] }, null] },
                    ],
                  },
                ],
              },
              1,
              0,
            ],
          },
        },
        totalEarnings: {
          $sum: {
            $cond: [
              {
                $and: [
                  "$isPaidQualified",
                  {
                    $or: [
                      { $eq: [{ $ifNull: ["$referralPayout.paid", false] }, true] },
                      { $ne: [{ $ifNull: ["$referralPayout.paidAt", null] }, null] },
                    ],
                  },
                ],
              },
              { $ifNull: ["$referralPayout.amount", 20] },
              0,
            ],
          },
        },
      },
    },
  ]);

  // Extract counts or default to 0
  const counts = countsResult[0] || {
    freeTrialCount: 0,
    paidPlansCount: 0,
    paidPlansPaidCount: 0,
    totalEarnings: 0,
  };

  // Calculate ready to payout amount
  const unpaidCount = counts.paidPlansCount - counts.paidPlansPaidCount;
  const readyToPayout = unpaidCount * 20;

  // Get list of paid referrals with details (only fields needed for privacy)
  const paidReferrals = await User.find({
    referredBy: referrerId,
    plan: { $in: ["pro", "business"] },
    "subscription.status": "active",
    active: { $ne: false },
  })
    .select("name emailID referralPayout.eligibleAt referralPayout.paidAt referralPayout.paid referralPayout.amount")
    .sort({ "referralPayout.eligibleAt": -1, createdAt: -1 })
    .lean();

  // Format the response with masked data for privacy
  const formattedPaidReferrals = paidReferrals.map((user) => ({
    name: maskName(user.name),
    emailID: maskEmail(user.emailID),
    eligibleAt: user.referralPayout?.eligibleAt || null,
    paidAt: user.referralPayout?.paidAt || null,
    paid: user.referralPayout?.paid || false,
    amount: user.referralPayout?.amount || 20,
  }));

  res.status(200).json({
    status: "success",
    data: {
      freeTrialCount: counts.freeTrialCount,
      paidPlansCount: counts.paidPlansCount,
      paidPlansPaidCount: counts.paidPlansPaidCount,
      readyToPayout,
      totalEarnings: counts.totalEarnings || 0,
      paidReferrals: formattedPaidReferrals,
    },
  });
});

/**
 * Mark payouts as paid (Admin only)
 * POST /api/v1/affiliate/payout
 * Body: { referrerId, referralUserIds[], paidTxnId?, paidMethod? }
 */
export const markPayoutsAsPaid = catchAsync(async (req, res, next) => {
  const { referrerId, referralUserIds, paidTxnId, paidMethod = "paypal" } = req.body;

  // Validation
  if (!referrerId || !referralUserIds || !Array.isArray(referralUserIds)) {
    return next(
      new AppError(
        "Please provide referrerId and referralUserIds array",
        400
      )
    );
  }

  if (referralUserIds.length === 0) {
    return next(new AppError("referralUserIds array cannot be empty", 400));
  }

  // Convert string IDs to ObjectIds
  const referrerObjectId = new mongoose.Types.ObjectId(referrerId);
  const referralObjectIds = referralUserIds.map(
    (id) => new mongoose.Types.ObjectId(id)
  );

  // Find all referred users to validate
  const referredUsers = await User.find({
    _id: { $in: referralObjectIds },
  }).select(
    "_id referredBy plan subscription.status referralPayout.paidAt"
  );

  // Track validation results
  let skippedNotBelongingToReferrer = 0;
  let skippedNotQualified = 0;
  let skippedAlreadyPaid = 0;
  const validUserIds = [];

  referredUsers.forEach((user) => {
    // Check if user actually belongs to this referrer
    if (!user.referredBy || user.referredBy.toString() !== referrerId) {
      skippedNotBelongingToReferrer++;
      return;
    }

    // Check if user is qualified (paid plan + active subscription)
    const isQualified =
      (user.plan === "pro" || user.plan === "business") &&
      user.subscription?.status === "active";

    if (!isQualified) {
      skippedNotQualified++;
      return;
    }

    // Check if already paid
    if (user.referralPayout?.paidAt) {
      skippedAlreadyPaid++;
      return;
    }

    // Valid for payout
    validUserIds.push(user._id);
  });

  // Update valid users
  let updatedCount = 0;
  if (validUserIds.length > 0) {
    const updateResult = await User.updateMany(
      { _id: { $in: validUserIds } },
      {
        $set: {
          "referralPayout.paid": true,
          "referralPayout.paidAt": new Date(),
          "referralPayout.paidTxnId": paidTxnId || null,
          "referralPayout.paidMethod": paidMethod,
        },
      }
    );
    updatedCount = updateResult.modifiedCount;
  }

  res.status(200).json({
    status: "success",
    message: "Payout marking completed",
    data: {
      updatedCount,
      skippedAlreadyPaid,
      skippedNotQualified,
      skippedNotBelongingToReferrer,
      totalProcessed: referralUserIds.length,
    },
  });
});

