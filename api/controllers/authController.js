import { promisify } from "util";
import crypto from "crypto";
import User from "./../../models/userModel.js";
import catchAsync from "./../../utils/catchAsync.js";
import jwt from "jsonwebtoken";
import AppError from "./../../utils/appError.js";
import sendEmail from "./../../utils/email.js";

// const bcrypt = require('bcryptjs');
const signToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN,
  });
};

const createSendToken = (user, statusCode, res) => {
  let token = signToken(user._id);
  const cookieOption = {
    expires: new Date(
      Date.now() + process.env.JWT_COOKIE_EXPIRES_IN * 24 * 60 * 60 * 1000
    ),
    httpOnly: true,
  };
  if (process.env.NODE_ENV === "prodcuction") cookieOption.secure = true;
  res.cookie("jwt-new", token, cookieOption);

  //remove password from output
  user.password = undefined;
  res.status(statusCode).json({
    status: "sucess",
    token,
    // data: {
    //   user: user,
    // },
  });
};

export const signup = catchAsync(async (req, res) => {
  const newUser = await User.create({
    name: req.body.name,
    emailID: req.body.emailID,
    password: req.body.password,
    passwordConfirm: req.body.passwordConfirm,
    passwordChangeAt: req.body.passwordChangeAt,
    role: req.body.role,
    plan: req.body.plan || "free", // Default to 'free' plan
    passwordForgotToken: req.body.passwordForgotToken,
    passwordExpireToken: req.body.passwordExpireToken,
  });

  createSendToken(newUser, 200, res);
});

export const login = catchAsync(async (req, res, next) => {
  // const email = req.body.emailID
  // const password = req.body.password
  //simple way

  const { emailID, password } = req.body;

  //check if email and password exist
  if (!emailID || !password) {
    return next(new AppError("please provide email and password", 400));
  }

  //check if user exist and password is correct
  const user = await User.findOne({ emailID }).select("+password");
  if (!user || !(await user.correctPassword(password, user.password))) {
    return next(new AppError("Incorrect email or Password", 400));
  }
  createSendToken(user, 200, res);
});

export const protect = catchAsync(async (req, res, next) => {
  // checking token if its there

  let token;

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith("Bearer")
  ) {
    token = req.headers.authorization.split(" ")[1];

  }

  if (!token) {
    return next(
      new AppError("user dont exist by this id or login with correct ID", 401)
    );
  }

  // verify token
  const decoded = await promisify(jwt.verify)(token, process.env.JWT_SECRET);
  //check if user still exist
  const freshUser = await User.findById(decoded.id);

  if (!freshUser) {
    return next(new AppError("the user belonging to this token doesnt exist"));
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
  // get user based on posted email

  const getUser = await User.findOne({ emailID: req.body.emailID });

  if (!getUser) {
    next(new AppError("there is no user with email address"));
  }

  //generate the random reset token

  const forgotToken = getUser.createPasswordForgottenToken();

  await getUser.save({ validateBeforeSave: false });

  //send it user's email ID

  const resetURL = `${req.protocol}://${req.get(
    "host"
  )}/api/v1/users/reset/${forgotToken}`;

  const message = `forgot your password ? submit a patch request with new password and confirmPassword to the :${resetURL}\n if you didnt forgot your password please ignore this email`;

  try {
    await sendEmail({
      emailID: getUser.emailID,

      subject: "your password reset token (valid for 10 mins only)",

      message,
    });

    res.status(200).json({
      status: "message",

      message: "token sent to email",
    });
  } catch (err) {

    getUser.passwordExpireToken = undefined;

    getUser.passwordForgotToken = undefined;

    await getUser.save({ validateBeforeSave: false });

    next(
      new AppError("there was an error sending the email, please try later!")
    );
  }
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
    return next(new AppError("token is invalid or has expired", 401));
  }

  user.password = req.body.password;

  user.passwordConfirm = req.body.passwordConfirm;

  user.passwordForgotToken = undefined;

  user.passwordExpireToken = undefined;

  await user.save();
  createSendToken(user, 200, res);
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
  getPwd.passwordCurrent = req.body.passwordCurrent;
  getPwd.passwordConfirm = req.body.passwordConfirm;
  await getPwd.save();
  createSendToken(getPwd, 200, res);
});

// authController.js
export const logout = (req, res) => {
  res.cookie("jwt", "loggedout", {
    expires: new Date(Date.now() + 10 * 1000),
    httpOnly: true,
  });
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

  // Create JWT token for the authenticated user
  createSendToken(req.user, 200, res);
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
        await user.save({ validateBeforeSave: false });
      } else {
        // Create new user
        user = new User({
          googleId,
          name,
          emailID: email,
          authProvider: "google",
          photo: picture,
          plan: "free", // Default plan for OAuth users
        });
        await user.save({ validateBeforeSave: false });
      }
    }
    createSendToken(user, 200, res);
  } catch (error) {
    console.error("Google token verification error:", error);
    return next(new AppError("Invalid Google token", 400));
  }
});
