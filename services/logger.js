const isProduction = process.env.NODE_ENV === "production";

const logger = {
  debug: (step, message, data = null) => {
    if (isProduction) return;
    const timestamp = new Date().toISOString();
    console.debug(
      `[${timestamp}] [DEBUG] [${step}] ${message}`,
      data ? JSON.stringify(data, null, 2) : ""
    );
  },
  info: (step, message, data = null) => {
    if (isProduction) return;
    const timestamp = new Date().toISOString();
    console.log(
      `[${timestamp}] [INFO] [${step}] ${message}`,
      data ? JSON.stringify(data, null, 2) : ""
    );
  },
  warn: (step, message, data = null) => {
    if (isProduction) return;
    const timestamp = new Date().toISOString();
    console.warn(
      `[${timestamp}] [WARN] [${step}] ${message}`,
      data ? JSON.stringify(data, null, 2) : ""
    );
  },
  error: (step, message, error = null) => {
    const timestamp = new Date().toISOString();
    console.error(
      `[${timestamp}] [ERROR] [${step}] ${message}`,
      error ? error.stack || error.message || error : ""
    );
  },
};

export default logger;
