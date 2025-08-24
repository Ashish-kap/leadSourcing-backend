import express from "express";
import * as authController from "./../api/controllers/authController.js";
import catchAsync from "../utils/catchAsync.js";
import socketService from "../services/socket.service.js";

const router = express.Router();

// Protect all routes
router.use(authController.protect);

/**
 * Get active jobs for the current user
 * GET /api/v1/job-status/active
 */
router.get(
  "/active",
  catchAsync(async (req, res, next) => {
    const userId = req.user.id;

    const Job = (await import("../models/jobModel.js")).default;

    const activeJobs = await Job.find({
      userId: userId,
      status: { $in: ["waiting", "active", "delayed"] },
    }).select("jobId status progress metrics startedAt createdAt jobParams");

    // Add runtime information
    const jobsWithRuntime = activeJobs.map((job) => {
      const runtime = job.startedAt ? Date.now() - job.startedAt.getTime() : 0;

      return {
        ...job.toObject(),
        runtime,
        runtimeMinutes: Math.floor(runtime / (1000 * 60)),
        runtimeFormatted: runtime > 0 ? formatDuration(runtime) : "N/A",
      };
    });

    res.status(200).json({
      status: "success",
      results: jobsWithRuntime.length,
      data: {
        jobs: jobsWithRuntime,
      },
    });
  })
);

/**
 * Check Socket.IO connection status
 * GET /api/v1/job-status/connection
 */
router.get(
  "/connection",
  catchAsync(async (req, res, next) => {
    const userId = req.user.id;
    const isConnected = socketService.isUserConnected(userId);

    res.status(200).json({
      status: "success",
      data: {
        userId: userId,
        isConnected: isConnected,
        connectedUsers: socketService.getConnectedUsersCount(),
        message: isConnected
          ? "User is connected to Socket.IO"
          : "User is not connected to Socket.IO",
      },
    });
  })
);

/**
 * Trigger active jobs status emit (useful for refreshing frontend)
 * POST /api/v1/job-status/refresh
 */
router.post(
  "/refresh",
  catchAsync(async (req, res, next) => {
    const userId = req.user.id;

    if (socketService.isUserConnected(userId)) {
      await socketService.sendActiveJobsStatus(userId);

      res.status(200).json({
        status: "success",
        message: "Active jobs status sent to connected sockets",
      });
    } else {
      res.status(200).json({
        status: "success",
        message: "User is not connected to Socket.IO",
      });
    }
  })
);

// Helper function to format duration
function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

export default router;
