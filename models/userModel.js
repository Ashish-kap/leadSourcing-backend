import mongoose from "mongoose";
import crypto from "crypto";
import validator from "validator";
import bcrypt from "bcryptjs";

const userSchema = new mongoose.Schema(
  {
    emailID: {
      type: String,
      required: [true, "Please type your Email ID"],
      unique: true,
      lowercase: true,
      validate: [validator.isEmail, "please provide a valid email"],
    },

    name: {
      type: String,
      required: [true, "Please type your name"],
    },

    role: {
      type: String,
      enum: ["user", "admin"],
      default: "user",
    },

    plan: {
      type: String,
      enum: ["free", "pro", "business"],
      default: "free",
    },

    password: {
      type: String,
      required: function () {
        return !this.googleId; // Password required only if not using Google OAuth
      },
      minlength: 8,
      select: false,
    },

    passwordConfirm: {
      type: String,
      required: function () {
        return !this.googleId && this.isNew; // Only required for new non-OAuth users
      },
      validate: {
        validator: function (el) {
          return el === this.password;
        },
        message: "password is not same.",
      },
    },

    // OAuth fields
    googleId: {
      type: String,
      sparse: true, // Allows multiple null values
    },

    authProvider: {
      type: String,
      enum: ["local", "google"],
      default: "local",
    },

    photo: {
      type: String,
    },

    dodoCustomerId: {
      type: String,
      sparse: true,
    },

    dodoBusinessId: {
      type: String,
    },

    dodoCustomerCreatedAt: {
      type: Date,
    },

    // Subscription details from webhook
    subscription: {
      subscriptionId: {
        type: String,
        sparse: true,
      },
      status: {
        type: String,
        enum: [
          "pending",
          "active",
          "on_hold",
          "cancelled",
          "failed",
          "expired",
        ],
        default: null,
      },
      nextBillingDate: {
        type: Date,
        default: null,
      },
      previousBillingDate: {
        type: Date,
        default: null,
      },
      paymentFrequencyCount: {
        type: Number,
        default: null,
      },
      paymentFrequencyInterval: {
        type: String,
        enum: ["Day", "Week", "Month", "Year"],
        default: null,
      },
      subscriptionPeriodCount: {
        type: Number,
        default: null,
      },
      subscriptionPeriodInterval: {
        type: String,
        enum: ["Day", "Week", "Month", "Year"],
        default: null,
      },
      payloadType: {
        type: String,
        default: null,
      },
      cancel_at_next_billing_date: {
        type: Boolean,
        default: false,
      },
    },

    // User credits and limits
    credits: {
      total: {
        type: Number,
        default: 1000,
      },
      used: {
        type: Number,
        default: 0,
      },
      remaining: {
        type: Number,
        default: 1000,
      },
      // Track when credits were last allocated for monthly reset
      lastAllocated: {
        type: Date,
        default: Date.now,
      },
      // Track monthly allocation for free users
      monthlyAllocated: {
        type: Boolean,
        default: false,
      },
    },

    passwordChangeAt: Date,
    passwordForgotToken: String,
    passwordExpireToken: Date,

    // Referral tracking fields
    referredBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User", // Enables population if needed later
    },
    referredAt: {
      type: Date,
    },

    // Referral payout tracking
    referralPayout: {
      amount: {
        type: Number,
        default: 20,
      },
      paid: {
        type: Boolean,
        default: false,
      },
      eligibleAt: {
        type: Date,
      },
      paidAt: {
        type: Date,
      },
      paidTxnId: {
        type: String,
      },
      paidMethod: {
        type: String,
      },
    },

    // Profile and attribution (who they are, where they came from)
    designation: {
      type: String,
      maxlength: [200, "Designation must be at most 200 characters"],
    },
    website: {
      type: String,
      maxlength: [500, "Website URL must be at most 500 characters"],
      validate: {
        validator: function (v) {
          if (!v || v.trim() === "") return true;
          return validator.isURL(v, { require_protocol: false });
        },
        message: "Please provide a valid URL",
      },
    },
    howDidYouHearAbout: {
      type: String,
      maxlength: [200, "How did you hear about us must be at most 200 characters"],
    },
    // User has completed profile/info step
    userInfo: {
      type: Boolean,
      default: false,
    },
    acquisition: {
      utmSource: { type: String, maxlength: 200 },
      utmMedium: { type: String, maxlength: 200 },
      utmCampaign: { type: String, maxlength: 200 },
      utmTerm: { type: String, maxlength: 200 },
      utmContent: { type: String, maxlength: 200 },
      signupSource: { type: String, maxlength: 100 },
      firstLandingPage: { type: String, maxlength: 500 },
    },

    active: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Virtual for credit percentage
userSchema.virtual("creditPercentage").get(function () {
  if (this.credits.total === 0) return 0;
  return ((this.credits.remaining / this.credits.total) * 100).toFixed(1);
});

// Method to check if user has unlimited access (no restrictions at all)
userSchema.methods.hasUnlimitedAccess = function () {
  return this.plan === "business" || this.plan === "pro" || this.plan === "free";
};

// Method to check if user has unlimited extraction (no credit limits)
// userSchema.methods.hasUnlimitedExtraction = function () {
//   return false // Only business plan has unlimited credits
// };

// TEMPORARY: free (and pro/business) have unlimited extraction
userSchema.methods.hasUnlimitedExtraction = function () {
  return this.plan === "business" || this.plan === "pro" || this.plan === "free";
};

// Method to get plan-specific maxRecords limit
userSchema.methods.getMaxRecordsLimit = function () {
  const planLimits = {
    free: 1000,
    pro: 1000,
    business: 1000
  };
  return planLimits[this.plan] || planLimits.free;
};

// Method to deduct credits - FIXED VERSION with plan-based bypass
userSchema.methods.deductCredits = async function (amount) {
  // Skip credit deduction for users with unlimited extraction (business only)
  if (this.hasUnlimitedExtraction()) {
    return this; // Return user instance without deduction
  }

  // Free and Pro users have credit limitations
  if (this.credits.remaining < amount) {
    throw new Error("Insufficient credits");
  }

  this.credits.used += amount;
  this.credits.remaining -= amount;

  // Use validateBeforeSave: false to skip validation
  return await this.save({ validateBeforeSave: false });
};

// Method to add credits - FIXED VERSION
userSchema.methods.addCredits = async function (amount) {
  this.credits.total += amount;
  this.credits.remaining += amount;

  // Use validateBeforeSave: false to skip validation
  return await this.save({ validateBeforeSave: false });
};

// Method to refund credits (used when job returns fewer results than expected)
userSchema.methods.refundCredits = async function (amount) {
  // Skip refund for users with unlimited extraction (business only)
  if (this.hasUnlimitedExtraction()) {
    return this; // Return user instance without refund
  }

  // Refund for Free and Pro users who have credit limitations
  this.credits.used = Math.max(0, this.credits.used - amount);
  this.credits.remaining = Math.min(
    this.credits.total,
    this.credits.remaining + amount
  );

  // Use validateBeforeSave: false to skip validation
  return await this.save({ validateBeforeSave: false });
};

// Method to update credits without validation - ALTERNATIVE APPROACH
userSchema.methods.updateCredits = async function (used, remaining, total) {
  // Use findByIdAndUpdate to avoid validation
  return await mongoose.model("User").findByIdAndUpdate(
    this._id,
    {
      "credits.used": used || this.credits.used,
      "credits.remaining": remaining || this.credits.remaining,
      "credits.total": total || this.credits.total,
    },
    { new: true }
  );
};

// Existing middleware and methods remain the same...
userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  this.password = await bcrypt.hash(this.password, 12);
  this.passwordConfirm = undefined;
  next();
});

userSchema.pre("save", async function (next) {
  if (!this.isModified("password") || this.isNew) return next();
  this.passwordChangeAt = Date.now() - 1000;
  next();
});

userSchema.pre(/^find/, async function (next) {
  this.find({ active: { $ne: false } });
});

userSchema.methods.correctPassword = async function (
  candidatePassword,
  userPassword
) {
  return await bcrypt.compare(candidatePassword, userPassword);
};

userSchema.methods.changePasswordAfter = async function (JWTTimestamp) {
  if (this.passwordChangeAt) {
    const changeTimeStamp = parseInt(this.passwordChangeAt.getTime() / 1000);
    return JWTTimestamp < changeTimeStamp;
  }
  return false;
};

userSchema.methods.createPasswordForgottenToken = function () {
  const forgotToken = crypto.randomBytes(32).toString("hex");
  this.passwordForgotToken = crypto
    .createHash("sha256")
    .update(forgotToken)
    .digest("hex");

  this.passwordExpireToken = Date.now() + 1000 * 60 * 1000;
  return forgotToken;
};

// Add sparse index on referredBy for query performance
userSchema.index({ referredBy: 1 }, { sparse: true });

// Add compound index for affiliate dashboard queries
userSchema.index({
  referredBy: 1,
  plan: 1,
  "subscription.status": 1,
  "referralPayout.paidAt": 1,
});

const User = mongoose.model("User", userSchema);
export default User;
