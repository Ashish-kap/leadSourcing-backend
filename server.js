import express from "express";
import cors from "cors";
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

// CORS configuration
const corsOptions = {
  origin: function (origin, callback) {
    console.log('CORS Debug - Origin:', origin);
    console.log('CORS Debug - NODE_ENV:', process.env.NODE_ENV);
    
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    const allowedOrigins = [
      'https://app.cazalead.com',
      'https://www.cazalead.com',
      'http://localhost:3000',
      'http://localhost:3001',
      'http://127.0.0.1:3000',
      'http://127.0.0.1:3001'
    ];
    
    // In development, allow all localhost origins
    if (process.env.NODE_ENV === 'development') {
      allowedOrigins.push('http://localhost:*', 'http://127.0.0.1:*');
    }
    
    if (allowedOrigins.includes(origin)) {
      console.log('CORS Debug - Origin allowed:', origin);
      callback(null, true);
    } else {
      console.log('CORS Debug - Origin blocked:', origin);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: [
    'Origin',
    'X-Requested-With',
    'Content-Type',
    'Accept',
    'Authorization',
    'Cache-Control',
    'Pragma',
    'Access-Control-Allow-Origin',
    'Access-Control-Allow-Headers',
    'Access-Control-Allow-Methods'
  ],
  exposedHeaders: ['Authorization'],
  optionsSuccessStatus: 200 // Some legacy browsers (IE11, various SmartTVs) choke on 204
};

// Middleware
app.use(cors(corsOptions));

// Handle preflight requests explicitly
app.options('*', cors(corsOptions));

app.use(express.json());
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
