import multer from "multer";
import sharp from "sharp";
import User from "./../../models/userModel.js";
import Job from "./../../models/jobModel.js";
import catchAsync from "./../../utils/catchAsync.js";
import AppError from "./../../utils/appError.js";
import APIFeatures from "./../../utils/apiFeatures.js";
import * as factory from "./handlerFactory.js";

const multerStorage = multer.memoryStorage();

const multerFilter = (req, file, cb) => {
  if (file.mimetype.startsWith("image")) {
    cb(null, true);
  } else {
    cb(new AppError("Not an image! Please upload only images.", 400), false);
  }
};

const upload = multer({
  storage: multerStorage,
  fileFilter: multerFilter,
});

export const uploadUserPhoto = upload.single("photo");
export const resizeUserPhoto = catchAsync(async (req, res, next) => {
  if (!req.file) return next();

  req.file.filename = `user-${req.user.id}-${Date.now()}.jpeg`;

  await sharp(req.file.buffer)
    .resize(500, 500)
    .toFormat("jpeg")
    .jpeg({ quality: 90 })
    .toFile(`public/img/users/${req.file.filename}`);

  next();
});

const filterObj = (obj, ...allowedFields) => {
  const newObj = {};
  Object.keys(obj).forEach((el) => {
    if (allowedFields.includes(el)) newObj[el] = obj[el];
  });
  return newObj;
};

// Create a safe user response that excludes sensitive data
const createSafeUserResponse = (user) => {
  const userObj = user.toObject();

  // Remove sensitive Dodo Payments data
  delete userObj.dodoBusinessId;
  delete userObj.dodoCustomerId;
  delete userObj.dodoCustomerCreatedAt;

  // Remove sensitive subscription data - only keep non-sensitive fields
  if (userObj.subscription) {
    const safeSubscription = {
      status: userObj.subscription.status,
      subscriptionId: userObj.subscription.subscriptionId,
      nextBillingDate: userObj.subscription.nextBillingDate,
      previousBillingDate: userObj.subscription.previousBillingDate,
      cancel_at_next_billing_date: userObj.subscription.cancel_at_next_billing_date,
      // paymentFrequencyCount: userObj.subscription.paymentFrequencyCount,
      paymentFrequencyInterval: userObj.subscription.paymentFrequencyInterval,
      // subscriptionPeriodCount: userObj.subscription.subscriptionPeriodCount,
      // subscriptionPeriodInterval: userObj.subscription.subscriptionPeriodInterval,
      // payloadType: userObj.subscription.payloadType,
    };
    userObj.subscription = safeSubscription;
  }

  // Remove other sensitive fields
  delete userObj.password;
  delete userObj.passwordConfirm;
  delete userObj.passwordChangeAt;
  delete userObj.passwordForgotToken;
  delete userObj.passwordExpireToken;
  delete userObj.__v;

  return userObj;
};

export const getMe = (req, res, next) => {
  req.params.id = req.user.id;
  next();
};

export const getMeWithStats = catchAsync(async (req, res, next) => {
  // Get user data
  const user = await User.findById(req.user.id);

  if (!user) {
    return next(new AppError("No user found with that ID", 404));
  }

  // Get user job extraction statistics
  const jobStats = await Job.getUserStats(req.user.id);

  // Create safe user response without sensitive data
  const safeUser = createSafeUserResponse(user);

  res.status(200).json({
    status: "success",
    data: {
      user: safeUser,
      extractionStats: jobStats,
    },
  });
});

export const updateMe = catchAsync(async (req, res, next) => {
  // 1) Create error if user POSTs password data
  if (req.body.password || req.body.passwordConfirm) {
    return next(
      new AppError(
        "This route is not for password updates. Please use /updateMyPassword.",
        400
      )
    );
  }

  // 2) Create error if user tries to update plan
  if (req.body.plan) {
    return next(
      new AppError(
        "Plan updates are not allowed through this route. Plan changes are managed automatically through your subscription.",
        400
      )
    );
  }

  // 3) Create error if user tries to update role
  if (req.body.role) {
    return next(
      new AppError(
        "Role updates are not allowed through this route. Role changes must be made by an administrator.",
        400
      )
    );
  }

  // 4) Filtered out unwanted fields names that are not allowed to be updated
  // Users cannot update their plan or role - these are managed by admins/webhooks
  const filteredBody = filterObj(req.body, "name", "email");
  if (req.file) filteredBody.photo = req.file.filename;

  // 5) Update user document
  const updatedUser = await User.findByIdAndUpdate(req.user.id, filteredBody, {
    new: true,
    runValidators: true,
  });

  res.status(200).json({
    status: "success",
    data: {
      user: createSafeUserResponse(updatedUser),
    },
  });
});

export const deleteMe = catchAsync(async (req, res, next) => {
  await User.findByIdAndUpdate(req.user.id, { active: false });

  res.status(204).json({
    status: "success",
    data: null,
  });
});

export const createUser = (req, res) => {
  res.status(500).json({
    status: "error",
    message: "This route is not defined! Please use /signup instead",
  });
};

// Safe version of getUser that excludes sensitive data
export const getUser = catchAsync(async (req, res, next) => {
  const user = await User.findById(req.params.id);

  if (!user) {
    return next(new AppError("No user found with that ID", 404));
  }

  res.status(200).json({
    status: "success",
    data: {
      data: createSafeUserResponse(user),
    },
  });
});

// Safe version of getAllUsers that excludes sensitive data
export const getAllUsers = catchAsync(async (req, res, next) => {
  const features = new APIFeatures(User.find(), req.query)
    .filter()
    .sort()
    .limitFields()
    .paginate();

  const users = await features.query;

  // Create safe responses for all users
  const safeUsers = users.map((user) => createSafeUserResponse(user));

  res.status(200).json({
    status: "success",
    results: safeUsers.length,
    data: {
      data: safeUsers,
    },
  });
});

// Custom updateUser function that prevents plan updates
export const updateUser = catchAsync(async (req, res, next) => {
  // Prevent plan updates through admin routes
  if (req.body.plan) {
    return next(
      new AppError(
        "Plan updates are not allowed through this route. Plan changes are managed automatically through subscriptions.",
        400
      )
    );
  }

  // Note: Admins can update roles, but plans are still protected

  // Use the factory method for other updates
  const updatedUser = await User.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
    runValidators: true,
  });

  if (!updatedUser) {
    return next(new AppError("No user found with that ID", 404));
  }

  res.status(200).json({
    status: "success",
    data: {
      data: createSafeUserResponse(updatedUser),
    },
  });
});

export const deleteUser = factory.deleteOne(User);
