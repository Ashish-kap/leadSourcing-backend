import { promisify } from "util";
import crypto from "crypto";
import User from "./../../models/userModel.js";
import catchAsync from "./../../utils/catchAsync.js";
import jwt from "jsonwebtoken";
import AppError from "./../../utils/appError.js";
import sendEmail from "./../../utils/email.js";
import { decodeReferralCode } from "./../../utils/referralCode.js";
import logger from "./../../services/logger.js";

const AUTH_COOKIE_NAME = "jwt";

// Maps request keys (body/query) to acquisition schema keys (camelCase)
const ACQUISITION_KEYS = [
  ["utm_source", "utmSource"],
  ["utmSource", "utmSource"],
  ["utm_medium", "utmMedium"],
  ["utmMedium", "utmMedium"],
  ["utm_campaign", "utmCampaign"],
  ["utmCampaign", "utmCampaign"],
  ["utm_term", "utmTerm"],
  ["utmTerm", "utmTerm"],
  ["utm_content", "utmContent"],
  ["utmContent", "utmContent"],
  ["signupSource", "signupSource"],
  ["referrer", "firstLandingPage"],
  ["firstLandingPage", "firstLandingPage"],
];

/**
 * Pick first-touch acquisition data from request (body or query).
 * Used at signup and Google OAuth to record where the user came from.
 * @param {object} req - Express request
 * @returns {object} Acquisition object with schema keys, or empty object
 */
const pickAcquisitionFromRequest = (req) => {
  const source = { ...req.body, ...req.query };
  const acquisition = {};
  ACQUISITION_KEYS.forEach(([inputKey, schemaKey]) => {
    const value = source[inputKey];
    if (value != null && String(value).trim() !== "") {
      acquisition[schemaKey] = String(value).trim();
    }
  });
  return acquisition;
};

const maskEmail = (emailID = "") => {
  if (!emailID || !emailID.includes("@")) return "unknown";
  const [name, domain] = emailID.split("@");
  const maskedName =
    name.length <= 2
      ? `${name[0] || "*"}*`
      : `${name.slice(0, 2)}${"*".repeat(Math.max(1, name.length - 2))}`;
  return `${maskedName}@${domain}`;
};

const getAuthLogContext = (req, emailID, extra = {}) => ({
  emailID: maskEmail(emailID),
  ip: req.ip,
  userAgent: req.get("user-agent"),
  ...extra,
});

const buildResetPasswordUrl = (req, resetToken) => {
  const frontendPattern = process.env.FRONTEND_RESET_PASSWORD_URL;
  if (frontendPattern) {
    if (frontendPattern.includes("{token}")) {
      return frontendPattern.replace("{token}", encodeURIComponent(resetToken));
    }
    const separator = frontendPattern.includes("?") ? "&" : "?";
    return `${frontendPattern}${separator}token=${encodeURIComponent(resetToken)}`;
  }

  if (process.env.FRONTEND_URL) {
    return `${process.env.FRONTEND_URL.replace(
      /\/$/,
      ""
    )}/reset-password?token=${encodeURIComponent(resetToken)}`;
  }

  return `${req.protocol}://${req.get(
    "host"
  )}/api/v1/users/resetPassword/${resetToken}`;
};

const buildVerificationEmailUrl = (req, rawToken) => {
  const frontendPattern = process.env.FRONTEND_VERIFY_EMAIL_URL;
  if (frontendPattern) {
    if (frontendPattern.includes("{token}")) {
      return frontendPattern.replace("{token}", encodeURIComponent(rawToken));
    }
    const separator = frontendPattern.includes("?") ? "&" : "?";
    return `${frontendPattern}${separator}token=${encodeURIComponent(rawToken)}`;
  }

  if (process.env.FRONTEND_URL) {
    return `${process.env.FRONTEND_URL.replace(
      /\/$/,
      ""
    )}/verify-email?token=${encodeURIComponent(rawToken)}`;
  }

  return `${req.protocol}://${req.get(
    "host"
  )}/api/v1/users/verifyEmail/${rawToken}`;
};

const sendVerificationEmail = async (req, user, rawToken) => {
  const verifyURL = buildVerificationEmailUrl(req, rawToken);

  const message = `Welcome! Please verify your email using this link:\n${verifyURL}\n\nThis link will expire in 10 minutes.`;
  const html = `<p>Welcome! Please follow <a href="${verifyURL}">this link</a> to verify your email address. This link will expire in 10 minutes.</p>`;

  await sendEmail({
    emailID: user.emailID,
    subject: "Cazalead - Verify your email address",
    message,
    html,
  });
};

// const bcrypt = require('bcryptjs');
const signToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN,
  });
};

const createSendToken = (user, statusCode, req, res) => {
  const token = signToken(user._id);
  const cookieOption = {
    expires: new Date(
      Date.now() + process.env.JWT_COOKIE_EXPIRES_IN * 24 * 60 * 60 * 1000
    ),
    httpOnly: true,
    sameSite: "lax",
  };

  if (
    process.env.NODE_ENV === "production" ||
    req.secure ||
    req.headers["x-forwarded-proto"] === "https"
  ) {
    cookieOption.secure = true;
  }
  res.cookie(AUTH_COOKIE_NAME, token, cookieOption);

  //remove password from output
  user.password = undefined;
  res.status(statusCode).json({
    status: "success",
    token,
    // data: {
    //   user: user,
    // },
  });
};

export const signup = catchAsync(async (req, res, next) => {
  const createPayload = {
    name: req.body.name,
    emailID: req.body.emailID,
    password: req.body.password,
    passwordConfirm: req.body.passwordConfirm,
    plan: "free",
    authProvider: "local",
  };
  const acquisition = pickAcquisitionFromRequest(req);
  if (Object.keys(acquisition).length > 0) {
    createPayload.acquisition = acquisition;
  }
  const newUser = await User.create(createPayload);
  const verificationToken = newUser.createEmailVerificationToken();
  await newUser.save({ validateBeforeSave: false });

  try {
    await sendVerificationEmail(req, newUser, verificationToken);
  } catch (err) {
    newUser.emailVerificationToken = undefined;
    newUser.emailVerificationExpires = undefined;
    await newUser.save({ validateBeforeSave: false });
    return next(
      new AppError("There was an error sending verification email.", 500)
    );
  }

  res.status(201).json({
    status: "success",
    message: "Signup successful. Please verify your email before logging in.",
  });
});

export const login = catchAsync(async (req, res, next) => {
  // const email = req.body.emailID
  // const password = req.body.password
  //simple way

  const { emailID, password } = req.body;

  //check if email and password exist
  if (!emailID || !password) {
    logger.warn(
      "AUTH_LOGIN_FAILED",
      "Missing email or password in login request",
      getAuthLogContext(req, emailID)
    );
    return next(new AppError("please provide email and password", 400));
  }

  //check if user exist and password is correct
  const user = await User.findOne({ emailID }).select("+password");
  if (user?.authProvider === "google" && !user.password) {
    logger.warn(
      "AUTH_LOGIN_FAILED_GOOGLE_ONLY",
      "OAuth-only account attempted password login",
      getAuthLogContext(req, emailID, { userId: user._id.toString() })
    );
    return next(
      new AppError(
        "This account uses Google sign-in. Please login with Google.",
        400
      )
    );
  }

  if (!user || !(await user.correctPassword(password, user.password))) {
    logger.warn(
      "AUTH_LOGIN_FAILED_CREDENTIALS",
      "Invalid login credentials",
      getAuthLogContext(req, emailID, { userFound: !!user })
    );
    return next(new AppError("Incorrect email or Password", 400));
  }

  if (user.authProvider === "local" && !user.isEmailVerified) {
    logger.warn(
      "AUTH_LOGIN_FAILED_UNVERIFIED",
      "Local account attempted login before email verification",
      getAuthLogContext(req, emailID, { userId: user._id.toString() })
    );
    return next(
      new AppError(
        "Please verify your email before logging in.",
        403
      )
    );
  }
  logger.info(
    "AUTH_LOGIN_SUCCESS",
    "User login successful",
    getAuthLogContext(req, emailID, {
      userId: user._id.toString(),
      authProvider: user.authProvider,
    })
  );
  createSendToken(user, 200, req, res);
});

export const verifyEmail = catchAsync(async (req, res, next) => {
  const hashedToken = crypto
    .createHash("sha256")
    .update(req.params.token)
    .digest("hex");

  const user = await User.findOne({
    emailVerificationToken: hashedToken,
    emailVerificationExpires: { $gt: Date.now() },
  });

  if (!user) {
    return next(new AppError("Email verification token is invalid or expired.", 400));
  }

  user.isEmailVerified = true;
  user.emailVerificationToken = undefined;
  user.emailVerificationExpires = undefined;
  await user.save({ validateBeforeSave: false });

  createSendToken(user, 200, req, res);
});

export const resendVerificationEmail = catchAsync(async (req, res, next) => {
  const { emailID } = req.body;

  if (!emailID) {
    return next(new AppError("Please provide your email address.", 400));
  }

  const user = await User.findOne({ emailID });

  if (!user) {
    return next(new AppError("There is no user with this email address.", 404));
  }

  if (user.authProvider !== "local") {
    return next(new AppError("This account uses Google sign-in.", 400));
  }

  if (user.isEmailVerified) {
    return res.status(200).json({
      status: "success",
      message: "Email is already verified. Please login.",
    });
  }

  const verificationToken = user.createEmailVerificationToken();
  await user.save({ validateBeforeSave: false });

  try {
    await sendVerificationEmail(req, user, verificationToken);
  } catch (err) {
    user.emailVerificationToken = undefined;
    user.emailVerificationExpires = undefined;
    await user.save({ validateBeforeSave: false });
    return next(
      new AppError("There was an error sending verification email.", 500)
    );
  }

  res.status(200).json({
    status: "success",
    message: "Verification email sent.",
  });
});

export const protect = catchAsync(async (req, res, next) => {
  // checking token if its there

  let token;

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith("Bearer")
  ) {
    token = req.headers.authorization.split(" ")[1];
  } else if (req.cookies?.[AUTH_COOKIE_NAME]) {
    token = req.cookies[AUTH_COOKIE_NAME];
  }

  if (!token) {
    return next(
      new AppError("You are not logged in. Please login to get access.", 401)
    );
  }

  // verify token
  const decoded = await promisify(jwt.verify)(token, process.env.JWT_SECRET);
  //check if user still exist
  const freshUser = await User.findById(decoded.id);

  if (!freshUser) {
    return next(
      new AppError("The user belonging to this token no longer exists.", 401)
    );
  }

  //check if user change the password after the token was issued

  if (await freshUser.changePasswordAfter(decoded.iat)) {
    return next(
      new AppError("user recently change his password. plz login again!", 401)
    );
  }

  //GRANT ACCESS TO PROTECTED ROUTE

  req.user = freshUser;

  next();
});

export const restrictTo = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return next(
        new AppError("you dont have permission to perform this action", 403)
      );
    }

    next();
  };
};

export const forgotPassword = catchAsync(async (req, res, next) => {
  const genericMessage =
    "If an account with that email exists, a password reset link has been sent.";
  const { emailID } = req.body;

  if (!emailID) {
    logger.warn(
      "AUTH_FORGOT_PASSWORD_INVALID",
      "Forgot password request missing email",
      getAuthLogContext(req, emailID)
    );
    return next(new AppError("Please provide your email address.", 400));
  }

  logger.info(
    "AUTH_FORGOT_PASSWORD_REQUESTED",
    "Forgot password requested",
    getAuthLogContext(req, emailID)
  );

  // Always return a generic response to avoid user enumeration.
  const user = await User.findOne({ emailID });
  if (!user) {
    logger.warn(
      "AUTH_FORGOT_PASSWORD_USER_NOT_FOUND",
      "Forgot password requested for non-existent account",
      getAuthLogContext(req, emailID)
    );
    return res.status(200).json({
      status: "success",
      message: genericMessage,
    });
  }

  const forgotToken = user.createPasswordForgottenToken();
  await user.save({ validateBeforeSave: false });

  const resetURL = buildResetPasswordUrl(req, forgotToken);
  const message = `Forgot your password? Reset it using this link:\n${resetURL}\n\nIf you did not request this, you can ignore this email.`;
  const html = `<p>Please follow <a href="${resetURL}">this link</a> to reset your password. If you did not request this, you can ignore this email.</p>`;

  try {
    await sendEmail({
      emailID: user.emailID,
      subject: "Cazalead - Password reset link (valid for 10 minutes)",
      message,
      html,
    });
    logger.info(
      "AUTH_FORGOT_PASSWORD_EMAIL_SENT",
      "Password reset email dispatched",
      getAuthLogContext(req, emailID, { userId: user._id.toString() })
    );
  } catch (err) {
    user.passwordExpireToken = undefined;
    user.passwordForgotToken = undefined;
    await user.save({ validateBeforeSave: false });
    logger.error(
      "AUTH_FORGOT_PASSWORD_EMAIL_FAILED",
      "Password reset email dispatch failed",
      getAuthLogContext(req, emailID, { userId: user._id.toString() })
    );
    return next(
      new AppError("There was an error sending the email, please try later!", 500)
    );
  }

  return res.status(200).json({
    status: "success",
    message: genericMessage,
  });
});

export const resetPassword = catchAsync(async (req, res, next) => {
  // get user based on token

  const hashedToken = crypto
    .createHash("sha256")
    .update(req.params.token)
    .digest("hex");

  const user = await User.findOne({
    passwordForgotToken: hashedToken,
    passwordExpireToken: { $gt: Date.now() },
  });

  //if token has not expired and there is user, set new password

  if (!user) {
    logger.warn(
      "AUTH_RESET_PASSWORD_FAILED",
      "Password reset failed due to invalid or expired token",
      getAuthLogContext(req)
    );
    return next(new AppError("token is invalid or has expired", 401));
  }

  user.password = req.body.password;

  user.passwordConfirm = req.body.passwordConfirm;

  user.passwordForgotToken = undefined;

  user.passwordExpireToken = undefined;

  await user.save();
  logger.info(
    "AUTH_RESET_PASSWORD_SUCCESS",
    "Password reset completed successfully",
    getAuthLogContext(req, user.emailID, { userId: user._id.toString() })
  );
  createSendToken(user, 200, req, res);
});

export const redirectResetPassword = catchAsync(async (req, res, next) => {
  const { token } = req.params;
  const redirectUrl = buildResetPasswordUrl(req, token);

  // If no frontend reset target is configured, fail clearly instead of falling through.
  if (redirectUrl.includes("/api/v1/users/resetPassword/")) {
    return next(
      new AppError(
        "Reset page is not configured. Please contact support",
        500
      )
    );
  }

  return res.redirect(302, redirectUrl);
});

export const updatePassword = catchAsync(async (req, res, next) => {
  //get user from collection

  const getPwd = await User.findById(req.user.id).select("+password");

  //check if posted current password is matching

  if (
    !(await getPwd.correctPassword(req.body.passwordCurrent, getPwd.password))
  ) {
    return next(
      new AppError("password is not matching or wrong password", 401)
    );
  }

  getPwd.password = req.body.password;
  getPwd.passwordConfirm = req.body.passwordConfirm;
  await getPwd.save();
  createSendToken(getPwd, 200, req, res);
});

// authController.js
export const logout = (req, res) => {
  const cookieOptions = {
    expires: new Date(Date.now() + 10 * 1000),
    httpOnly: true,
    sameSite: "lax",
  };

  if (
    process.env.NODE_ENV === "production" ||
    req.secure ||
    req.headers["x-forwarded-proto"] === "https"
  ) {
    cookieOptions.secure = true;
  }

  res.cookie(AUTH_COOKIE_NAME, "loggedout", cookieOptions);
  res.status(200).json({ status: "success" });
};

// Google OAuth Controllers
export const googleAuth = (req, res, next) => {
  // This will redirect to Google's OAuth page
  // Handled by passport middleware
};

export const googleCallback = catchAsync(async (req, res, next) => {
  // User data is available in req.user after successful authentication
  if (!req.user) {
    return next(new AppError("Google authentication failed", 400));
  }

  const refCode = req.headers['x-referral-code'] || req.cookies?.ref;

  // Save referral only on first attribution (don't overwrite)
  if (refCode && !req.user.referredBy) {
    const referringUserId = decodeReferralCode(refCode);

    if (referringUserId) {
      // Verify referring user exists
      const referringUser = await User.findById(referringUserId);

      if (
        referringUser &&
        referringUser._id.toString() !== req.user._id.toString()
      ) {
        req.user.referredBy = referringUserId;
        req.user.referredAt = new Date();
        await req.user.save({ validateBeforeSave: false });
      }
    }
  }

  // First-touch acquisition: set only if not already set (from query/state on OAuth redirect)
  const acquisition = pickAcquisitionFromRequest(req);
  const hasAcquisition = req.user.acquisition && Object.keys(req.user.acquisition).length > 0;
  if (Object.keys(acquisition).length > 0 && !hasAcquisition) {
    req.user.acquisition = acquisition;
    await req.user.save({ validateBeforeSave: false });
  }

  // Create JWT token for the authenticated user
  createSendToken(req.user, 200, req, res);
});

// Token-based authentication for mobile/API
export const googleTokenAuth = catchAsync(async (req, res, next) => {
  const { authToken } = req.body;

  if (!authToken) {
    return next(new AppError("Google token is required", 400));
  }

  try {
    // Import OAuth2Client correctly
    const { OAuth2Client } = await import("google-auth-library");
    const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

    // Verify the Google token
    const ticket = await client.verifyIdToken({
      idToken: authToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    const googleId = payload.sub;
    const email = payload.email;
    const name = payload.name;
    const picture = payload.picture;

    // Check if user exists
    let user = await User.findOne({ googleId });

    if (!user) {
      // Check if user exists with same email
      user = await User.findOne({ emailID: email });

      if (user) {
        // Link Google account to existing user
        user.googleId = googleId;
        user.authProvider = "google";
        user.isEmailVerified = true;
        user.emailVerificationToken = undefined;
        user.emailVerificationExpires = undefined;
        const acquisition = pickAcquisitionFromRequest(req);
        const hasAcquisition = user.acquisition && Object.keys(user.acquisition).length > 0;
        if (Object.keys(acquisition).length > 0 && !hasAcquisition) {
          user.acquisition = acquisition;
        }
        await user.save({ validateBeforeSave: false });
      } else {
        // Create new user
        const createPayload = {
          googleId,
          name,
          emailID: email,
          authProvider: "google",
          isEmailVerified: true,
          photo: picture,
          plan: "free", // Default plan for OAuth users
        };
        const acquisition = pickAcquisitionFromRequest(req);
        if (Object.keys(acquisition).length > 0) {
          createPayload.acquisition = acquisition;
        }
        user = new User(createPayload);
        await user.save({ validateBeforeSave: false });
      }
    }

    // Handle referral tracking - check both header and cookies
    const headerRefCode = req.headers['x-referral-code'];
    const cookieRefCode = req.cookies?.ref;
    const refCode = headerRefCode || cookieRefCode;

    // Save referral only on first attribution (don't overwrite)
    if (refCode && !user.referredBy) {
      const referringUserId = decodeReferralCode(refCode);

      if (referringUserId) {
        // Verify referring user exists
        const referringUser = await User.findById(referringUserId);

        if (
          referringUser &&
          referringUser._id.toString() !== user._id.toString()
        ) {
          user.referredBy = referringUserId;
          user.referredAt = new Date();
          await user.save({ validateBeforeSave: false });
        }
      }
    }

    createSendToken(user, 200, req, res);
  } catch (error) {
    return next(new AppError("Invalid Google token", 400));
  }
});
