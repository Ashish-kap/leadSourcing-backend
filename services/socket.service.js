import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import { promisify } from "util";
import User from "../models/userModel.js";

class SocketService {
  constructor() {
    this.io = null;
    this.userConnections = new Map(); // Map to store userId -> [socketIds]
  }

  init(server) {
    this.io = new Server(server, {
      cors: {
        origin: "*",
        methods: ["GET", "POST"],
      },
    });

    // Authentication middleware for socket connections
    this.io.use(async (socket, next) => {
      try {
        console.log("🔐 Socket.IO Authentication attempt:", {
          socketId: socket.id,
          hasAuth: !!socket.handshake.auth,
          hasToken: !!socket.handshake.auth.token,
          tokenPreview: socket.handshake.auth.token
            ? socket.handshake.auth.token.substring(0, 20) + "..."
            : "none",
        });

        const token = socket.handshake.auth.token;

        if (!token) {
          console.log("❌ Socket.IO Auth failed: No token provided");
          throw new Error("No token provided");
        }

        // Verify JWT token
        const decoded = await promisify(jwt.verify)(
          token,
          process.env.JWT_SECRET
        );

        console.log("✅ Socket.IO JWT verified for user:", decoded.id);

        // Get user from database
        const user = await User.findById(decoded.id).select("+active");

        if (!user) {
          console.log("❌ Socket.IO Auth failed: User not found:", decoded.id);
          throw new Error("User no longer exists");
        }

        if (!user.active) {
          console.log("❌ Socket.IO Auth failed: User inactive:", decoded.id);
          throw new Error("User account is deactivated");
        }

        // Add user info to socket
        socket.userId = user._id.toString();
        socket.user = user;

        console.log("✅ Socket.IO Authentication successful:", {
          userId: user._id.toString(),
          socketId: socket.id,
        });

        next();
      } catch (err) {
        console.log("❌ Socket.IO Authentication error:", err.message);
        next(new Error("Authentication error: " + err.message));
      }
    });

    // Handle socket connections
    this.io.on("connection", (socket) => {
      console.log(
        `🟢 User ${socket.userId} connected with socket ${socket.id}`
      );

      // Add socket to user connections map
      this.addUserConnection(socket.userId, socket.id);

      // Join user to their personal room for receiving job updates
      socket.join(`user_${socket.userId}`);
      console.log(
        `👥 User ${socket.userId} joined room: user_${socket.userId}`
      );

      // Handle disconnection
      socket.on("disconnect", () => {
        console.log(
          `🔴 User ${socket.userId} disconnected from socket ${socket.id}`
        );
        this.removeUserConnection(socket.userId, socket.id);
      });

      // Handle request for active jobs
      socket.on("get_active_jobs", () => {
        console.log(`📋 User ${socket.userId} requested active jobs`);
        this.sendActiveJobsStatus(socket.userId);
      });

      // Send current active jobs when user connects
      this.sendActiveJobsStatus(socket.userId);
    });

    console.log("Socket.IO server initialized for real-time job updates");
    return this.io;
  }

  // Add socket connection for user
  addUserConnection(userId, socketId) {
    if (!this.userConnections.has(userId)) {
      this.userConnections.set(userId, new Set());
    }
    this.userConnections.get(userId).add(socketId);
  }

  // Remove socket connection for user
  removeUserConnection(userId, socketId) {
    if (this.userConnections.has(userId)) {
      this.userConnections.get(userId).delete(socketId);
      if (this.userConnections.get(userId).size === 0) {
        this.userConnections.delete(userId);
      }
    }
  }

  // Emit job status update to specific user
  emitJobUpdate(userId, eventType, jobData) {
    if (this.io) {
      this.io.to(`user_${userId}`).emit("job_update", {
        type: eventType,
        job: jobData,
        timestamp: new Date().toISOString(),
      });
    }
  }

  // Emit job progress to specific user
  emitJobProgress(userId, jobId, progress) {
    if (this.io) {
      this.io.to(`user_${userId}`).emit("job_progress", {
        jobId,
        progress,
        timestamp: new Date().toISOString(),
      });
    }
  }

  // Send current active jobs status to user
  async sendActiveJobsStatus(userId) {
    try {
      const Job = (await import("../models/jobModel.js")).default;

      const activeJobs = await Job.find({
        userId: userId,
        status: { $in: ["waiting", "active", "delayed"] },
      }).select("jobId status progress metrics createdAt startedAt jobParams");

      if (this.io) {
        this.io.to(`user_${userId}`).emit("active_jobs_status", {
          jobs: activeJobs,
          timestamp: new Date().toISOString(),
        });
      }
    } catch (error) {
      console.error("Error fetching active jobs:", error);
    }
  }

  // Check if user is connected
  isUserConnected(userId) {
    return (
      this.userConnections.has(userId) &&
      this.userConnections.get(userId).size > 0
    );
  }

  // Get connected users count
  getConnectedUsersCount() {
    return this.userConnections.size;
  }
}

// Export singleton instance
export default new SocketService();
