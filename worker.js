import dotenv from "dotenv";
dotenv.config();

process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (warning.name === "DeprecationWarning" && warning.message.includes("punycode")) return;
  console.warn(warning.name, warning.message);
});

import mongoose from "mongoose";
import socketService from "./services/socket.service.js";
import { createRedisClient } from "./services/redisClient.js";
import { initWorkers } from "./services/queue.js";
import logger from "./services/logger.js";

const DB = process.env.DATABASE.replace("password", process.env.DATABASE_PASSWORD);

mongoose.connect(DB).then(() => {
  logger.info("DB_CONNECTED", "Worker: Database connection successful");
});

// Redis emitter lets this process emit Socket.IO events through Redis
// The API server's Socket.IO (with Redis adapter) forwards them to connected clients
const redisClient = createRedisClient();
socketService.initEmitter(redisClient);

await initWorkers();

logger.info("WORKER_READY", "Bull workers started and ready to process jobs");
