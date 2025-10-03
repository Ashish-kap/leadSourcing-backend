// import mongoose from "mongoose";
// import crypto from "crypto";
// import validator from "validator";
// import bcrypt from "bcryptjs";

// const userSchema = new mongoose.Schema({
//   emailID: {
//     type: String,
//     required: [true, "Please type your Email ID"],
//     unique: true,
//     lowercase: true,
//     validate: [validator.isEmail, "please provide a valid email"],
//   },

//   name: {
//     type: String,
//     required: [true, "Please type your name"],
//   },

//   role: {
//     type: String,
//     enum: ["user", "tour-guide", "lead-guide", "admin"],
//     default: "user",
//   },
//   password: {
//     type: String,
//     required: [true, "Please type your password"],
//     minlength: 8,
//     select: false,
//   },

//   passwordConfirm: {
//     type: String,
//     required: [true, "Please type your password again to confirm"],
//     // this only work on CREATE AND SAVE()

//     validate: {
//       validator: function (el) {
//         return el === this.password;
//       },

//       message: "password is not same.",
//     },
//   },

//   photo: {
//     type: String,
//   },

//   passwordChangeAt: Date,

//   passwordForgotToken: String,

//   passwordExpireToken: Date,

//   active: {
//     type: Boolean,

//     default: true,
//   },
// });

// userSchema.pre("save", async function (next) {
//   // only run this function if password was actually modified

//   if (!this.isModified("password")) return next();

//   //hash the password with cost of 12

//   this.password = await bcrypt.hash(this.password, 12);

//   //delete the passwordconfirm

//   this.passwordConfirm = undefined;

//   next();
// });

// userSchema.pre("save", async function (next) {
//   if (!this.isModified("password") || this.isNew) return next();

//   this.passwordChangeAt = Date.now() - 1000;

//   next();
// });

// userSchema.pre(/^find/, async function (next) {
//   // this is points to the current query

//   this.find({ active: { $ne: false } });
// });

// userSchema.methods.correctPassword = async function (
//   canditatePassword,
//   userPassword
// ) {
//   return await bcrypt.compare(canditatePassword, userPassword);
// };

// userSchema.methods.changePasswordAfter = async function (JWTTimestamp) {
//   if (this.passwordChangeAt) {
//     const changeTimeStamp = parseInt(this.passwordChangeAt.getTime() / 1000);

//     console.log(changeTimeStamp, JWTTimestamp);

//     return JWTTimestamp < changeTimeStamp;
//   }

//   // false means user didnt change password

//   return false;
// };

// userSchema.methods.createPasswordForgottenToken = function () {
//   const forgotToken = crypto.randomBytes(32).toString("hex");
//   this.passwordForgotToken = crypto
//     .createHash("sha256")
//     .update(forgotToken)
//     .digest("hex");

//   this.passwordExpireToken = Date.now() + 1000 * 60 * 1000;

//   console.log({ forgotToken }, this.passwordForgotToken);

//   return forgotToken;
// };

// const User = mongoose.model("User", userSchema);

// export default User;

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
    },

    // User credits and limits
    credits: {
      total: {
        type: Number,
        default: 2000,
      },
      used: {
        type: Number,
        default: 0,
      },
      remaining: {
        type: Number,
        default: 2000,
      },
    },

    passwordChangeAt: Date,
    passwordForgotToken: String,
    passwordExpireToken: Date,

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
  return this.plan === "business";
};

// Method to check if user has unlimited extraction (no credit limits)
userSchema.methods.hasUnlimitedExtraction = function () {
  return (
    // this.plan === "business" ||  this.plan === "free"
    this.plan === "business"
  );
};

// Method to deduct credits - FIXED VERSION with plan-based bypass
userSchema.methods.deductCredits = async function (amount) {
  // Skip credit deduction for users with unlimited extraction (business, free)
  if (this.hasUnlimitedExtraction()) {
    return this; // Return user instance without deduction
  }

  // Only pro users have credit limitations
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

const User = mongoose.model("User", userSchema);
export default User;
