import express from "express";
import cors from "cors";
import { createServer } from "http";
import scraperRouter from "./Routes/scraper.js";
import { createBullBoard } from "@bull-board/api";
import { BullAdapter } from "@bull-board/api/bullAdapter.js";
import { ExpressAdapter } from "@bull-board/express";
import scraperQueue from "./services/queue.js";
import userRoute from "./Routes/userRoutes.js";
import jobStatusRoute from "./Routes/jobStatus.js";
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
const app = express();
const httpServer = createServer(app);
app.use(express.json({ limit: "500kb" }));

// Middleware
app.use(cors());
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

//limit request from same API
const limiter = rateLimit({
  max: 100,
  windowMs: 60 * 60 * 1000,
  message: "too many request from this ip, please try again in an hour",
});

// Bull Dashboard
const serverAdapter = new ExpressAdapter();
createBullBoard({
  queues: [new BullAdapter(scraperQueue)],
  serverAdapter,
});

serverAdapter.setBasePath("/admin");
app.use("/admin", serverAdapter.getRouter());

// Routes
app.use("/api", limiter);
app.use("/api/v1/users", userRoute);
app.use("/api/v1", scraperRouter);
app.use("/api/v1/job-status", jobStatusRoute);

// app.all("*", (req, res, next) => {
//   next(new AppError(`cant find ${req.originalUrl} on this server`, 404));
// });

app.use(globalErrController);

// mongodb
const DB = process.env.DATABASE.replace(
  "password",
  process.env.DATABASE_PASSWORD
);

mongoose
  .connect(DB, {
    useNewUrlParser: true,
  })
  .then((con) => {
    logger.info("DB_CONNECTED", "Database connection successful");
  });

// Initialize Socket.IO
socketService.init(httpServer);

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
