import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { createServer } from "http";
import scraperRouter from "./Routes/scraper.js";
import { createBullBoard } from "@bull-board/api";
import { BullAdapter } from "@bull-board/api/bullAdapter.js";
import { ExpressAdapter } from "@bull-board/express";
import queueService from "./services/queue.js";

// Suppress punycode deprecation warning (comes from third-party dependencies)
// This warning is from older versions of whatwg-url/tr46 used by dependencies
// and will be resolved when dependencies are updated
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (
    warning.name === "DeprecationWarning" &&
    warning.message.includes("punycode")
  ) {
    return; // Suppress punycode deprecation warnings
  }
  console.warn(warning.name, warning.message);
});

const { businessQueue, freeProQueue } = queueService;
import userRoute from "./Routes/userRoutes.js";
import jobStatusRoute from "./Routes/jobStatus.js";
import dodoPaymentsRouter from "./Routes/dodoPayments.js";
import webhookRouter from "./Routes/webhook.js";
import feedbackRouter from "./Routes/feedbackRoutes.js";
import affiliateRouter from "./Routes/affiliateRoutes.js";
import AppError from "./utils/appError.js";
import globalErrController from "./api/controllers/errController.js";
import expressMongoSanitize from "express-mongo-sanitize";
import helmet from "helmet";
import xssClean from "xss-clean";
import logger from "./services/logger.js";
import hpp from "hpp";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import mongoose from "mongoose";
import socketService from "./services/socket.service.js";
import passport from "passport";
import "./config/passport.js"; // Initialize passport configuration
import creditsJob from "./jobs/creditsJob.js";
import creditsRouter from "./Routes/creditsRoutes.js";
const app = express();
const httpServer = createServer(app);

// Trust proxy - Required for Railway/production (enables X-Forwarded-For header)
app.set("trust proxy", 1);

app.use(express.json({ limit: "500kb" }));

// Middleware
// CORS configuration - allow frontend origin and credentials for cookies
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:5173",
    credentials: true, // Allow cookies to be sent
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.use(express.json());
app.use(cookieParser());
// Serve static files
app.use(express.static("public"));
// app.use(expressMongoSanitize());
// app.use(xssClean());
app.use(hpp());
app.use(helmet());

// Initialize passport middleware
app.use(passport.initialize());

if (process.env.NODE_ENV === "development") {
  app.use(morgan("dev"));
}

// Webhook route without rate limiting (must be before rate limiter)
app.use("/api/v1", webhookRouter);

//limit request from same API
const limiter = rateLimit({
  max: 100,
  windowMs: 60 * 60 * 1000,
  message: "too many request from this ip, please try again in an hour",
});

// Bull Dashboard - Monitor both queues
const serverAdapter = new ExpressAdapter();
createBullBoard({
  queues: [
    new BullAdapter(businessQueue, { name: "Business Plan Queue" }),
    new BullAdapter(freeProQueue, { name: "Free/Pro Plan Queue" }),
  ],
  serverAdapter,
});

serverAdapter.setBasePath("/admin");
app.use("/admin", serverAdapter.getRouter());

// Routes
app.use("/api", limiter);
app.use("/api/v1/users", userRoute);
app.use("/api/v1/dodo-payments", dodoPaymentsRouter);
app.use("/api/v1", scraperRouter);
app.use("/api/v1/job-status", jobStatusRoute);
app.use("/api/v1/feedback", feedbackRouter);
app.use("/api/v1/credits", creditsRouter);
app.use("/api/v1/affiliate", affiliateRouter);

// app.all("*", (req, res, next) => {
//   next(new AppError(`cant find ${req.originalUrl} on this server`, 404));
// });

app.use(globalErrController);

// mongodb
const DB = process.env.DATABASE.replace(
  "password",
  process.env.DATABASE_PASSWORD
);

mongoose.connect(DB).then((con) => {
  logger.info("DB_CONNECTED", "Database connection successful");
});

// Initialize Socket.IO
socketService.init(httpServer);

// Initialize Credits Job
creditsJob.init();

// Start Server
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  logger.info("SERVER_STARTED", `Server running on port ${PORT}`);
  logger.info("DASHBOARD_URL", `Dashboard: http://localhost:${PORT}/admin`);
  logger.info(
    "JOB_MONITOR_URL",
    `Job Monitor: http://localhost:${PORT}/job-monitor.html`
  );
  logger.info(
    "SOCKETIO_READY",
    "Socket.IO server initialized for real-time job updates"
  );
});