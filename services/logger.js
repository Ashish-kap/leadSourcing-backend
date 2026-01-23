const isProduction = process.env.NODE_ENV === "production";

const MAX_LOGS_PER_SECOND = Math.max(
  1,
  parseInt(process.env.LOGS_PER_SECOND_LIMIT || "500", 10)
);

let tokens = MAX_LOGS_PER_SECOND;
let droppedInWindow = 0;

const refillBucket = () => {
  tokens = MAX_LOGS_PER_SECOND;
  if (droppedInWindow > 0 && tokens > 0) {
    tokens -= 1;
    const ts = new Date().toISOString();
    console.warn(
      `[${ts}] [WARN] [LOGGER] Rate limit reached; messages dropped: ${droppedInWindow}`
    );
  }
  droppedInWindow = 0;
};

if (isProduction) {
  // Refill once per second
  setInterval(refillBucket, 1000).unref?.();
}

const stringify = (obj) => {
  if (obj == null) return "";
  try {
    return typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
  } catch (_) {
    return String(obj);
  }
};

const emit = (level, step, message, extra) => {
  const timestamp = new Date().toISOString();

  // In production, apply rate limiting across all levels
  if (isProduction) {
    if (tokens <= 0) {
      droppedInWindow += 1;
      return; // drop this log
    }
    tokens -= 1;
  }

  const line = `[${timestamp}] [${level}] [${step}] ${message}`;
  const extraOut = extra ? stringify(extra) : "";

  switch (level) {
    case "DEBUG":
      console.debug(line, extraOut);
      break;
    case "INFO":
      console.log(line, extraOut);
      break;
    case "WARN":
      console.warn(line, extraOut);
      break;
    case "ERROR":
      if (extra && extra.stack) {
        console.error(line, extra.stack);
      } else if (extra && extra.message) {
        console.error(line, extra.message);
      } else {
        console.error(line, extraOut);
      }
      break;
    default:
      console.log(line, extraOut);
  }
};

const logger = {
  debug: (step, message, data = null) => {
    // Keep debug silent in production as before
    if (isProduction) return;
    emit("DEBUG", step, message, data);
  },
  info: (step, message, data = null) => {
    // Keep info silent in production as before
    if (isProduction) return;
    emit("INFO", step, message, data);
  },
  warn: (step, message, data = null) => {
    // Keep warn silent in production as before
    if (isProduction) return;
    emit("WARN", step, message, data);
  },
  error: (step, message, error = null) => {
    // Errors are logged in all envs, but rate-limited in production
    emit("ERROR", step, message, error);
  },
};

export default logger;
