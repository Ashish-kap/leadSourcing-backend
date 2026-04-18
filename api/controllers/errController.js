import AppError from "../../utils/appError.js";

const sendErrDev = (err, res) => {
  res.status(err.statusCode).json({
    status: err.status,
    message: err.message,
    stack: err.stack,
  });
};

const sendErrProd = (err, res) => {
  // Operational, trusted error
  if (err.isOperational) {
    res.status(err.statusCode).json({
      status: err.status,
      message: err.message,
    });
  } else {
    // Programming or other unknown error: don't leak details
    console.error("error😢", err);
    res.status(500).json({
      status: "error",
      msg: "something went wrong",
    });
  }
};

const handleCastErrorDB = (err) => {
  const message = `invalid ${err.path}: ${err.value}`;
  return new AppError(message, 400);
};

const handleDuplicateFieldsDB = (err) => {
  const keyValue = err.keyValue || {};
  const field = Object.keys(keyValue)[0];
  const value = field ? keyValue[field] : undefined;

  if (field === "emailID") {
    return new AppError("An account with this email already exists", 409);
  }

  const suffix =
    field && value !== undefined ? ` (${field}: ${String(value)})` : "";
  return new AppError(
    `Duplicate field value${suffix}. Please use another value`,
    409
  );
};

const handleJWTError = () =>
  new AppError("Invalid token. Please login again", 401);

const handleTokenExpiredError = () =>
  new AppError(
    "Your token has expired or your password was changed. Please login again!",
    401
  );

const normalizeErr = (err) => {
  if (err.code === 11000) return handleDuplicateFieldsDB(err);
  if (err.name === "CastError") return handleCastErrorDB(err);
  if (err.name === "JsonWebTokenError") return handleJWTError();
  if (err.name === "TokenExpiredError") return handleTokenExpiredError();
  return err;
};

export default (err, req, res, next) => {
  err.statusCode = err.statusCode || 500;
  err.status = err.status || "error";

  const error = normalizeErr(err);

  if (process.env.NODE_ENV === "development") {
    sendErrDev(error, res);
  } else if (process.env.NODE_ENV === "production") {
    sendErrProd(error, res);
  } else {
    sendErrProd(error, res);
  }
};
